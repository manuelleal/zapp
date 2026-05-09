require("dotenv").config();
const { createSigner } = require("fast-jwt");
const http = require("http");

const userId = "cmox0zru00000thac2id9m45b";
const sign = createSigner({ key: process.env.JWT_SECRET });
const token = sign({ id: userId, email: "ddiddimmo@gmail.com", nombre: "Christiam" });

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: "127.0.0.1", port: 3000, path, method,
      headers: { Authorization: `Bearer ${token}` },
    };
    if (body != null) {
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(body);
    }
    const r = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    r.on("error", reject);
    if (body != null) r.write(body);
    r.end();
  });
}

(async () => {
  // 1. GET /api/fichas (default: only active)
  const r1 = await req("GET", "/api/fichas");
  const j1 = JSON.parse(r1.body);
  console.log("GET /api/fichas (default):", r1.status, "fichas:", j1.fichas.length);
  console.log("  sample:", JSON.stringify(j1.fichas[0], null, 2).slice(0, 300));

  // 2. PATCH archive first ficha
  const fid = j1.fichas[0].id;
  const r2 = await req("PATCH", `/api/fichas/${fid}`, JSON.stringify({ archivada: true }));
  console.log("PATCH archivar:", r2.status, r2.body);

  // 3. GET default again -> should have 14
  const r3 = await req("GET", "/api/fichas");
  const j3 = JSON.parse(r3.body);
  console.log("GET default after archive:", r3.status, "fichas:", j3.fichas.length);

  // 4. GET incluirArchivadas=1 -> 15
  const r4 = await req("GET", "/api/fichas?incluirArchivadas=1");
  const j4 = JSON.parse(r4.body);
  console.log("GET incluirArchivadas=1:", r4.status, "fichas:", j4.fichas.length);

  // 5. PATCH unarchive
  const r5 = await req("PATCH", `/api/fichas/${fid}`, JSON.stringify({ archivada: false }));
  console.log("PATCH desarchivar:", r5.status, r5.body);

  // 6. GET evidencias (no fichas have any yet but route should respond)
  const r6 = await req("GET", `/api/fichas/${fid}/evidencias`);
  console.log("GET evidencias:", r6.status, r6.body.slice(0, 200));

  // 7. PATCH non-existent evidencia → 404
  const r7 = await req("PATCH", `/api/evidencias/nope`, JSON.stringify({ cerrada: true }));
  console.log("PATCH cerrar nope:", r7.status, r7.body);

  // 8. PATCH bad body → 400
  const r8 = await req("PATCH", `/api/fichas/${fid}`, JSON.stringify({ wrong: true }));
  console.log("PATCH bad body:", r8.status, r8.body);
})();
