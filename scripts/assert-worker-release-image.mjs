import { spawnSync } from "node:child_process";
import { releaseImageMetadataMismatches } from "./lib/release-image-metadata.mjs";

const [imageRef, expectedHead] = process.argv.slice(2);
if (!imageRef || !expectedHead || !/^[0-9a-f]{40}$/i.test(expectedHead)) {
  process.stderr.write("Uso: node scripts/assert-worker-release-image.mjs <imagem> <commit-sha>\n");
  process.exit(2);
}

const inspected = spawnSync("docker", ["image", "inspect", imageRef], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (inspected.error || inspected.status !== 0) {
  process.stderr.write("Não foi possível inspecionar a imagem de worker antes da publicação.\n");
  process.exit(2);
}

let image;
try {
  image = JSON.parse(inspected.stdout)[0];
} catch {
  process.stderr.write("docker inspect retornou metadados inválidos para o worker.\n");
  process.exit(2);
}

const labels = image?.Config?.Labels ?? {};
const expectedImageLabels = {
  "com.clientix.artifact": "worker-production",
  "com.clientix.test-trust-root": "false",
};
const mismatches = [
  ...releaseImageMetadataMismatches(labels, expectedHead),
  ...Object.entries(expectedImageLabels)
    .filter(([key, value]) => labels[key] !== value)
    .map(([key]) => key),
];
if (mismatches.length) {
  process.stderr.write(
    `Publicação do worker recusada: labels OCI não elegíveis para release (${mismatches.join(", ")}).\n`,
  );
  process.exit(1);
}

process.stdout.write("Worker production elegível; labels OCI e source HEAD confirmados.\n");
