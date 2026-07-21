/**
 * Check this machine can run RevenueOS. Exit 0 = go, 1 = blocked.
 *
 *   npm run preflight
 *
 * Called by install/windows/setup.ps1 before it does anything irreversible,
 * and safe to run any time afterwards to diagnose a machine that has stopped
 * behaving. All the decision logic lives in src/lib/preflight.ts, where it is
 * unit tested — the installer must not be the only thing that has ever
 * exercised it.
 */
import path from "node:path";
import {
  APP_PORT,
  checkClaudeCli,
  checkDiskSpace,
  checkNativeModule,
  checkNodeVersion,
  checkPortFree,
  checkWritable,
  formatCheck,
  summarize,
  type Check,
} from "../src/lib/preflight";

async function main(): Promise<void> {
  const dataDir = path.join(process.cwd(), "data");

  const checks: Check[] = [
    checkNodeVersion(process.version),
    checkNativeModule(),
    checkWritable(dataDir),
    checkDiskSpace(process.cwd()),
    await checkPortFree(APP_PORT),
    checkClaudeCli(),
  ];

  console.log("\nRevenueOS preflight\n");
  for (const c of checks) console.log(formatCheck(c));

  const { ok, fatalFailures, warnings } = summarize(checks);

  if (warnings.length) {
    console.log("\nWorks, but degraded:\n");
    for (const w of warnings) {
      console.log(`  ! ${w.name} — ${w.detail}`);
      if (w.fix) console.log(`    ${w.fix}\n`);
    }
  }

  if (!ok) {
    console.log("\nBLOCKED — fix these before installing:\n");
    for (const f of fatalFailures) {
      console.log(`  ✗ ${f.name} — ${f.detail}`);
      if (f.fix) console.log(`    ${f.fix}\n`);
    }
    process.exit(1);
  }

  console.log("\n✓ This machine can run RevenueOS.\n");
}

main().catch((err) => {
  console.error(`Preflight itself failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
