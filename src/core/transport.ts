/**
 * The HTTP seam. `Transport` is a `fetch`-shaped function; everything that
 * talks to the network takes one. Production uses the global `fetch` (available
 * in Node 18+ and Bun); tests inject a fake that returns canned Responses, so
 * no unit test ever touches the network.
 */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export const fetchTransport: Transport = (url, init) => fetch(url, init);
