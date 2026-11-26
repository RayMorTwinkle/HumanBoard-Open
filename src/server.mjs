import { Board } from "./board.mjs";
import { boardServer } from "./http.mjs";

const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("PORT 应为 0 至 65535 的整数。");
const board = new Board();
const server = boardServer(board);
server.listen(port, "127.0.0.1", () =>
  console.log(`HumanBoard Open · http://127.0.0.1:${server.address().port}`),
);
const close = () => server.close(() => board.close());
process.once("SIGINT", close);
process.once("SIGTERM", close);
