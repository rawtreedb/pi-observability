import { createServer } from "node:http";

/** @returns {Promise<{url: string, requests: object[], close: () => Promise<void>}>} */
export async function startCollector() {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, table: req.headers["x-rawtree-traces-table"], payload: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
