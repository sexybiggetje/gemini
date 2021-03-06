'use strict'

const {createServer: createTlsServer} = require('tls')
const {EventEmitter} = require('events')
const createParser = require('./lib/request-parser')
const createResponse = require('./lib/response')
const {
	ALPN_ID,
	MIN_TLS_VERSION,
} = require('./lib/util')

const createGeminiServer = (opt = {}, onRequest) => {
	if (typeof opt === 'function') {
		onRequest = opt
		opt = {}
	}
	const {
		cert, key, passphrase,
		tlsOpt,
		verifyAlpnId,
	} = {
		cert: null, key: null, passphrase: null,
		tlsOpt: {},
		verifyAlpnId: alpnId => alpnId === ALPN_ID,
		...opt,
	}

	const onConnection = (socket) => {
		// todo: clarify if this is desired behavior
		if (verifyAlpnId(socket.alpnProtocol) !== true) {
			socket.destroy()
			return;
		}
		if (
			socket.authorizationError &&
			// allow self-signed certs
			socket.authorizationError !== 'SELF_SIGNED_CERT_IN_CHAIN' &&
			socket.authorizationError !== 'DEPTH_ZERO_SELF_SIGNED_CERT' &&
			socket.authorizationError !== 'UNABLE_TO_GET_ISSUER_CERT'
		) {
			socket.destroy(new Error(socket.authorizationError))
			return;
		}
		const clientCert = socket.getPeerCertificate()

		const req = createParser()
		socket.pipe(req)
		socket.once('error', (err) => {
			socket.unpipe(req)
			req.destroy(err)
		})

		const close = () => {
			socket.destroy()
			req.destroy()
		}
		let timeout = setTimeout(close, 20 * 1000)

		req.once('header', (header) => {
			clearTimeout(timeout)

			// prepare req
			req.socket = socket
			req.url = header.url
			const url = new URL(header.url, 'http://foo/')
			req.path = url.pathname
			if (clientCert && clientCert.fingerprint) {
				req.clientFingerprint = clientCert.fingerprint
			}
			// todo: req.abort(), req.destroy()

			// prepare res
			const res = createResponse()
			res.pipe(socket)
			res.once('error', (err) => {
				console.error('error', err)
				res.unpipe(socket)
				socket.destroy(err)
			})
			Object.defineProperty(res, 'socket', {value: socket})

			onRequest(req, res)
			server.emit('request', req, res)
		})
	}

	const server = createTlsServer({
		ALPNProtocols: [ALPN_ID],
		minVersion: MIN_TLS_VERSION,
		// > Usually the server specifies in the Server Hello message if a
		// > client certificate is needed/wanted.
		// > Does anybody know if it is possible to perform an authentication
		// > via client cert if the server does not request it?
		//
		// > The client won't send a certificate unless the server asks for it
		// > with a `Certificate Request` message (see the standard, section
		// > 7.4.4). If the server does not ask for a certificate, the sending
		// > of a `Certificate` and a `CertificateVerify` message from the
		// > client is likely to imply an immediate termination from the server
		// > (with an unexpected_message alert).
		// https://security.stackexchange.com/a/36101
		requestCert: true,
		// > Gemini requests typically will be made without a client
		// > certificate being sent to the server. If a requested resource
		// > is part of a server-side application which requires persistent
		// > state, a Gemini server can [...] request that the client repeat
		// the request with a "transient certificate" to initiate a client
		// > certificate section.
		rejectUnauthorized: false,
		cert, key, passphrase,
		...tlsOpt,
	}, onConnection)

	return server
}

module.exports = createGeminiServer
