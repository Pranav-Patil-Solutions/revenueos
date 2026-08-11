import { strict as assert } from "node:assert";
import { settleId } from "./helpers";
import { test } from "node:test";
import Database from "better-sqlite3";
import { book } from "../src/lib/book";
import { initSchema, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import { trialBalance } from "../src/lib/reports";
import {
  computeTds,
  NO_PAN_BP,
  q24Summary,
  q26Summary,
  TDS_SECTIONS,
  tdsRegister,
} from "../src/lib/tax/tds";
import { postManualVoucher, postVoucherWithTds } from "../src/lib/vouchers";

const R = (rupees: number) => rupees * 100;

/** Books with one supplier who has a PAN and one who does not. */
function tdsDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  migrate(db, MIGRATIONS, { now: "2026-01-01T00:00:00.000Z" });
  db.prepare(
    `INSERT INTO parties (name, kind, gstin, pan, state_code, phone, created_at)
     VALUES ('Verma Contractors', 'supplier', '', 'ABCPV1234F', '27', '', '2026-04-01T00:00:00Z'),
            ('Cash Labour Co', 'supplier', '', '', '27', '', '2026-04-01T00:00:00Z')`
  ).run();
  return db;
}
const VERMA = 1; // has PAN
const NOPAN = 2;

// ---------------------------------------------------------------------------
// computeTds — exact basis-point arithmetic
// ---------------------------------------------------------------------------

test("basis-point math is exact at 1%, 2% and 10%", () => {
  assert.equal(computeTds(R(10_000), "194C", true).tds_paise, R(100)); // 1%
  assert.equal(computeTds(R(10_000), "194C", true, true).tds_paise, R(200)); // alt 2%
  assert.equal(computeTds(R(10_000), "194J", true).tds_paise, R(1_000)); // 10%
  assert.equal(computeTds(R(10_000), "194H", true).tds_paise, R(200)); // 2%
  // The rounding step is single and half-up: 1% of ₹150.50 = ₹1.505 → ₹1.51.
  assert.equal(computeTds(15_050, "194C", true).tds_paise, 151);
  // net + tds always reassembles the base exactly.
  const c = computeTds(R(98_765) + 43, "194J", true);
  assert.equal(c.tds_paise + c.net_paise, c.base_paise);
});

test("no PAN forces the penal rate — as a floor, never a reduction", () => {
  const c = computeTds(R(10_000), "194C", false);
  assert.equal(c.bp, NO_PAN_BP);
  assert.equal(c.tds_paise, R(2_000)); // 20%, not 1%
  assert.equal(c.no_pan, true);
  assert.match(c.warnings.join(" "), /No PAN on record/);
  // With a PAN the section rate stands and no such warning appears.
  const ok = computeTds(R(10_000), "194C", true);
  assert.equal(ok.no_pan, false);
  assert.ok(!ok.warnings.some((w) => /No PAN/.test(w)));
});

test("thresholds warn but never auto-skip the deduction", () => {
  // ₹20,000 is under 194C's ₹30,000 single-payment limit — but the annual
  // aggregate test is the office's to apply, so TDS is still computed.
  const c = computeTds(R(20_000), "194C", true);
  assert.equal(c.below_threshold, true);
  assert.equal(c.tds_paise, R(200));
  assert.match(c.warnings.join(" "), /annual aggregate/);
});

test("verified sections cite the gazette and drop the unconfirmed warning", () => {
  for (const s of TDS_SECTIONS) {
    // All five were verified 2026-07-21 against ITA 2025 s.392/s.393. A new
    // section added unverified will (correctly) fail here — verify it or
    // exclude it deliberately.
    assert.equal(s.verified, true, s.code);
    assert.match(s.source, /gazette|Gazette/, `${s.code} verified without a citation`);
    const c = computeTds(R(60_000), s.code, true);
    assert.doesNotMatch(c.warnings.join(" "), /unconfirmed/);
  }
  assert.throws(() => computeTds(R(100), "999Z", true), /Unknown TDS section/);
  assert.throws(() => computeTds(-1, "194C", true), /non-negative/);
});

test("verified thresholds: 194J ₹50,000/yr and 194I ₹50,000/month", () => {
  // 194J moved ₹30,000 → ₹50,000 (ITA 2025 s.393(1) Table 6(iii)) — a
  // ₹40,000 fee that used to deduct is now below the threshold.
  assert.equal(computeTds(R(40_000), "194J", true).below_threshold, true);
  assert.equal(computeTds(R(50_000), "194J", true).below_threshold, false);
  // 194I is now a per-month test at ₹50,000 — one month's rent of ₹45,000
  // warns, ₹60,000 deducts. The old ₹2,40,000/yr aggregate is gone, and the
  // warning must not tell the office to check an aggregate that no longer
  // exists.
  const rent = computeTds(R(45_000), "194I", true);
  assert.equal(rent.below_threshold, true);
  assert.match(rent.warnings.join(" "), /month/i);
  assert.doesNotMatch(rent.warnings.join(" "), /annual aggregate/);
  assert.equal(computeTds(R(60_000), "194I", true).below_threshold, false);
  const rentNote = TDS_SECTIONS.find((s) => s.code === "194I")!.note;
  assert.match(rentNote, /month/i);
});

test("salary (192B) has no standard rate and says so", () => {
  const c = computeTds(R(50_000), "192B", true);
  assert.equal(c.tds_paise, 0);
  assert.match(c.warnings.join(" "), /enter the amount from your own computation/);
});

// ---------------------------------------------------------------------------
// postVoucherWithTds — the atomic journal + register write
// ---------------------------------------------------------------------------

test("a 194C payment posts Dr expense / Cr 2300 / Cr bank, register row linked", () => {
  const db = tdsDb();
  const { journalId, tdsEntryId, computation } = postVoucherWithTds(book(db, 1), {
    entry_date: "2026-07-10",
    memo: "Shed repair",
    ref_no: "TDS-1",
    party_id: VERMA,
    expense_account_code: "5900",
    base_paise: R(10_000),
    section: "194C",
    bank_account_id: settleId(db, 1, "bank"),
  });
  assert.equal(computation.tds_paise, R(100));

  const bal = (code: string) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(jl.debit_paise) - SUM(jl.credit_paise), 0) AS b
           FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
           WHERE a.code = ? AND jl.journal_id = ?`
        )
        .get(code, journalId) as { b: number }
    ).b;
  assert.equal(bal("5900"), R(10_000));
  assert.equal(bal("2300"), -R(100));
  assert.equal(bal("1100"), -R(9_900));
  assert.equal(trialBalance(book(db, 1)).balanced, true);

  const entry = db
    .prepare("SELECT * FROM tds_entries WHERE id = ?")
    .get(tdsEntryId) as { journal_id: number; challan_id: number | null; rate_bp: number };
  assert.equal(entry.journal_id, journalId);
  assert.equal(entry.challan_id, null); // deducted, not yet deposited
  assert.equal(entry.rate_bp, 100);
  const j = db
    .prepare("SELECT entry_type FROM journals WHERE id = ?")
    .get(journalId) as { entry_type: string };
  assert.equal(j.entry_type, "tds_deduction");
});

test("ATOMIC: a register insert failure leaves no journal behind", () => {
  const db = tdsDb();
  const before = (db.prepare("SELECT COUNT(*) n FROM journals").get() as { n: number }).n;
  // Sabotage only the register table; the journal write path stays healthy.
  db.exec("DROP TABLE tds_entries");
  db.exec("CREATE TABLE tds_entries (id INTEGER PRIMARY KEY CHECK (id < 0))");
  assert.throws(() =>
    postVoucherWithTds(book(db, 1), {
      entry_date: "2026-07-10",
      memo: "Doomed",
      ref_no: "X",
      party_id: VERMA,
      expense_account_code: "5900",
      base_paise: R(10_000),
      section: "194C",
      bank_account_id: settleId(db, 1, "bank"),
    })
  );
  const after = (db.prepare("SELECT COUNT(*) n FROM journals").get() as { n: number }).n;
  assert.equal(after, before, "the journal must roll back with the register row");
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM journal_lines").get() as { n: number }).n,
    0
  );
});

test("no-PAN payee is deducted at 20% through the posting path too", () => {
  const db = tdsDb();
  const { computation } = postVoucherWithTds(book(db, 1), {
    entry_date: "2026-07-11",
    memo: "Casual labour",
    ref_no: "TDS-2",
    party_id: NOPAN,
    expense_account_code: "5900",
    base_paise: R(10_000),
    section: "194C",
    bank_account_id: settleId(db, 1, "cash"),
  });
  assert.equal(computation.tds_paise, R(2_000));
  assert.equal(computation.no_pan, true);
});

test("the manual override books the office's own figure (salary), bounded by the bill", () => {
  const db = tdsDb();
  const { computation, journalId } = postVoucherWithTds(book(db, 1), {
    entry_date: "2026-07-31",
    memo: "July salary",
    ref_no: "SAL-7",
    party_id: VERMA,
    expense_account_code: "5900",
    base_paise: R(50_000),
    section: "192B",
    bank_account_id: settleId(db, 1, "bank"),
    tds_paise_override: R(3_500),
  });
  assert.equal(computation.tds_paise, 0); // what the engine said
  const cr2300 = db
    .prepare(
      `SELECT COALESCE(SUM(jl.credit_paise),0) b FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id WHERE a.code='2300' AND jl.journal_id=?`
    )
    .get(journalId) as { b: number };
  assert.equal(cr2300.b, R(3_500)); // what was actually booked
  assert.throws(
    () =>
      postVoucherWithTds(book(db, 1), {
        entry_date: "2026-07-31",
        memo: "bad",
        ref_no: "",
        party_id: VERMA,
        expense_account_code: "5900",
        base_paise: R(1_000),
        section: "192B",
        bank_account_id: settleId(db, 1, "bank"),
        tds_paise_override: R(2_000), // more than the bill
      }),
    /between zero and the bill/
  );
});

test("an override stores its EFFECTIVE rate in the register, not the unused default", () => {
  // ₹3,500 on ₹50,000 is 7% = 700 bp; storing the section default (0 for
  // 192B) would make the register's rate disagree with what was deducted.
  const db = tdsDb();
  const { tdsEntryId } = postVoucherWithTds(book(db, 1), {
    entry_date: "2026-07-31",
    memo: "salary",
    ref_no: "",
    party_id: VERMA,
    expense_account_code: "5900",
    base_paise: R(50_000),
    section: "192B",
    bank_account_id: settleId(db, 1, "bank"),
    tds_paise_override: R(3_500),
  });
  const row = db
    .prepare("SELECT rate_bp, tds_paise FROM tds_entries WHERE id = ?")
    .get(tdsEntryId) as { rate_bp: number; tds_paise: number };
  assert.equal(row.rate_bp, 700);
  assert.equal(row.tds_paise, R(3_500));
  // An override that happens to equal the computed figure keeps the section bp.
  const same = postVoucherWithTds(book(db, 1), {
    entry_date: "2026-08-01", memo: "", ref_no: "", party_id: VERMA,
    expense_account_code: "5900", base_paise: R(10_000), section: "194C",
    bank_account_id: settleId(db, 1, "bank"), tds_paise_override: R(100),
  });
  const sameRow = db
    .prepare("SELECT rate_bp FROM tds_entries WHERE id = ?")
    .get(same.tdsEntryId) as { rate_bp: number };
  assert.equal(sameRow.rate_bp, 100);
});

test("the schema refuses a challan without a backing journal", () => {
  const db = tdsDb();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO tds_challans (fy, quarter, form, challan_no, bsr_code, paid_on, amount_paise, journal_id, created_at)
           VALUES ('2026-27', 1, '26Q', 'X', '', '2026-07-05', 100, NULL, 'now')`
        )
        .run(),
    /NOT NULL/
  );
});

test("a zero-TDS voucher (below-rate override) still posts a clean two-leg journal", () => {
  const db = tdsDb();
  const { journalId } = postVoucherWithTds(book(db, 1), {
    entry_date: "2026-07-12",
    memo: "No deduction",
    ref_no: "",
    party_id: VERMA,
    expense_account_code: "5900",
    base_paise: R(5_000),
    section: "194C",
    bank_account_id: settleId(db, 1, "cash"),
    tds_paise_override: 0,
  });
  const legs = (db
    .prepare("SELECT COUNT(*) n FROM journal_lines WHERE journal_id = ?")
    .get(journalId) as { n: number }).n;
  assert.equal(legs, 2); // no zero-amount 2300 leg — the SQL CHECK would reject it
  assert.equal(trialBalance(book(db, 1)).balanced, true);
});

test("books lock refuses a back-dated TDS voucher atomically", () => {
  const db = tdsDb();
  db.prepare("UPDATE companies SET books_locked_through = '2026-07-31' WHERE id = 1").run();
  assert.throws(
    () =>
      postVoucherWithTds(book(db, 1), {
        entry_date: "2026-07-10",
        memo: "late",
        ref_no: "",
        party_id: VERMA,
        expense_account_code: "5900",
        base_paise: R(10_000),
        section: "194C",
        bank_account_id: settleId(db, 1, "bank"),
      }),
    /locked/
  );
  assert.equal((db.prepare("SELECT COUNT(*) n FROM tds_entries").get() as { n: number }).n, 0);
});

// ---------------------------------------------------------------------------
// Quarterly summaries and the challan cycle
// ---------------------------------------------------------------------------

function seedQuarterData(db: Database.Database): void {
  // Q1 (Apr–Jun): two 194C payments to Verma, one to the no-PAN payee.
  for (const [date, base] of [
    ["2026-04-15", R(10_000)],
    ["2026-06-20", R(20_000)],
  ] as const) {
    postVoucherWithTds(book(db, 1), {
      entry_date: date, memo: "work", ref_no: "", party_id: VERMA,
      expense_account_code: "5900", base_paise: base, section: "194C",
      bank_account_id: settleId(db, 1, "bank"),
    });
  }
  postVoucherWithTds(book(db, 1), {
    entry_date: "2026-05-01", memo: "labour", ref_no: "", party_id: NOPAN,
    expense_account_code: "5900", base_paise: R(10_000), section: "194C",
    bank_account_id: settleId(db, 1, "cash"),
  });
  // Q2 (Jul–Sep): salary — 24Q, not 26Q.
  postVoucherWithTds(book(db, 1), {
    entry_date: "2026-07-31", memo: "salary", ref_no: "", party_id: VERMA,
    expense_account_code: "5900", base_paise: R(50_000), section: "192B",
    bank_account_id: settleId(db, 1, "bank"), tds_paise_override: R(3_500),
  });
}

test("26Q groups by payee+section within the quarter; salary stays out", () => {
  const db = tdsDb();
  seedQuarterData(db);
  const q1 = q26Summary(book(db, 1), "2026-27", 1);
  assert.equal(q1.lines.length, 2); // Verma aggregated, no-PAN separate
  const verma = q1.lines.find((l) => l.party_id === VERMA)!;
  assert.equal(verma.deductions, 2);
  assert.equal(verma.base_paise, R(30_000));
  assert.equal(verma.tds_paise, R(300));
  assert.equal(verma.missing_pan, false);
  const nopan = q1.lines.find((l) => l.party_id === NOPAN)!;
  assert.equal(nopan.tds_paise, R(2_000));
  assert.equal(nopan.missing_pan, true);
  assert.equal(q1.missing_pan_count, 1);
  assert.equal(q1.total_tds_paise, R(2_300));
  // Salary is Q2 and 24Q — invisible to both Q1 and 26Q.
  assert.equal(q26Summary(book(db, 1), "2026-27", 2).lines.length, 0);
  const q2Salary = q24Summary(book(db, 1), "2026-27", 2);
  assert.equal(q2Salary.lines.length, 1);
  assert.equal(q2Salary.total_tds_paise, R(3_500));
});

test("the challan row itself names its form — junk or missing form is refused", () => {
  const db = tdsDb();
  const j = postManualVoucher(book(db, 1), {
    kind: "journal", entry_type: "tds_challan", entry_date: "2026-07-05",
    memo: "", ref_no: "",
    legs: [
      { account_code: "2300", party_id: null, debit_paise: 100, credit_paise: 0 },
      { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: 100 },
    ],
  });
  const ins = (form: string | null) =>
    db.prepare(
      `INSERT INTO tds_challans (fy, quarter, form, challan_no, bsr_code, paid_on, amount_paise, journal_id, created_at)
       VALUES ('2026-27', 1, ?, 'C', '', '2026-07-05', 100, ?, 'now')`
    ).run(form, j.journalId);
  assert.throws(() => ins(null), /NOT NULL/);
  assert.throws(() => ins("27Q"), /CHECK/);
  ins("24Q"); // a valid form inserts
});

test("a challan covers one return form — salary and non-salary never share one", () => {
  // Both kinds of deduction in the SAME quarter; the action's pending query
  // must partition them so 26Q and 24Q undeposited figures stay reconcilable
  // from the challan rows.
  const db = tdsDb();
  postVoucherWithTds(book(db, 1), {
    entry_date: "2026-05-10", memo: "work", ref_no: "", party_id: VERMA,
    expense_account_code: "5900", base_paise: R(10_000), section: "194C",
    bank_account_id: settleId(db, 1, "bank"),
  });
  postVoucherWithTds(book(db, 1), {
    entry_date: "2026-05-31", memo: "salary", ref_no: "", party_id: VERMA,
    expense_account_code: "5900", base_paise: R(50_000), section: "192B",
    bank_account_id: settleId(db, 1, "bank"), tds_paise_override: R(3_500),
  });
  // The exact filter createTdsChallan uses.
  const pendingFor = (form: string) =>
    db
      .prepare(
        `SELECT tds_paise FROM tds_entries
         WHERE challan_id IS NULL AND entry_date BETWEEN '2026-04-01' AND '2026-06-30'
           AND (CASE WHEN ? = '24Q' THEN section = '192B' ELSE section <> '192B' END)`
      )
      .all(form) as { tds_paise: number }[];
  assert.deepEqual(pendingFor("26Q").map((e) => e.tds_paise), [R(100)]);
  assert.deepEqual(pendingFor("24Q").map((e) => e.tds_paise), [R(3_500)]);
});

test("challan deposit zeroes 2300 and stamps the entries it covered", () => {
  const db = tdsDb();
  seedQuarterData(db);
  const q1 = q26Summary(book(db, 1), "2026-27", 1);
  assert.equal(q1.undeposited_paise, R(2_300));

  // The deposit: one journal Dr 2300 / Cr Bank, a challan row, and the
  // entries stamped — the same one-transaction shape the action uses.
  const now = "2026-07-05T00:00:00Z";
  db.transaction(() => {
    const { journalId } = postManualVoucher(book(db, 1), {
      kind: "journal",
      entry_type: "tds_challan",
      entry_date: "2026-07-05",
      memo: "TDS deposit Q1",
      ref_no: "CHLN-1",
      legs: [
        { account_code: "2300", party_id: null, debit_paise: R(2_300), credit_paise: 0 },
        { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: R(2_300) },
      ],
    });
    const challanId = db
      .prepare(
        `INSERT INTO tds_challans (fy, quarter, form, challan_no, bsr_code, paid_on, amount_paise, journal_id, created_at)
         VALUES ('2026-27', 1, '26Q', 'CHLN-1', '0001234', '2026-07-05', ?, ?, ?)`
      )
      .run(R(2_300), journalId, now).lastInsertRowid as number;
    db.prepare(
      `UPDATE tds_entries SET challan_id = ? WHERE challan_id IS NULL AND entry_date BETWEEN '2026-04-01' AND '2026-06-30'`
    ).run(challanId);
  })();

  // 2300 held ₹2,300 from Q1; the deposit clears exactly that. (The Q2 salary
  // deduction keeps its own ₹3,500 balance — only Q1 was deposited.)
  const bal2300 = (
    db
      .prepare(
        `SELECT COALESCE(SUM(jl.debit_paise) - SUM(jl.credit_paise), 0) b
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '2300'`
      )
      .get() as { b: number }
  ).b;
  assert.equal(bal2300, -R(3_500)); // only the undeposited salary remains
  assert.equal(q26Summary(book(db, 1), "2026-27", 1).undeposited_paise, 0);
  assert.equal(trialBalance(book(db, 1)).balanced, true);
  const register = tdsRegister(book(db, 1), "2026-27");
  assert.equal(register.filter((r) => r.challan_id !== null).length, 3);
});
