import { writeFile } from "node:fs/promises";
import { WorkspaceStore } from "../packages/server/dist/store.js";

const [dataDir, changeSetId, digest, baseRevision, crashAfterFileMutation, signalPath] = process.argv.slice(2);
if (!dataDir || !changeSetId || !digest || !baseRevision) {
  throw new Error("transaction crash worker arguments are incomplete");
}

const store = new WorkspaceStore({
  dataDir,
  ...(crashAfterFileMutation && signalPath ? {
    afterFileMutation: async ({ journal, step }) => {
      if (step !== crashAfterFileMutation) return;
      await writeFile(signalPath, `${JSON.stringify({ transactionId: journal.transactionId, changeSetId, stage: journal.stage, step })}\n`, "utf8");
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
  } : {})
});
await store.initialize();
await store.confirmAndApplyChangeSet(changeSetId, { digest, baseRevision });
