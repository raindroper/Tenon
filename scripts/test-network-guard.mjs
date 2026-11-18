import { Socket } from 'node:net';

const loopback = host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host);
const blocked = () => new Error('Offline tests permit loopback fixtures only; external network access is disabled.');
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!loopback(url.hostname)) return Promise.reject(blocked());
  return fetch(input, init);
};
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  // net.createConnection passes Node's normalized [options, callback] tuple.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (!options.path && !loopback(options.host ?? options.hostname ?? 'localhost')) throw blocked();
  return connect.apply(this, args);
};
