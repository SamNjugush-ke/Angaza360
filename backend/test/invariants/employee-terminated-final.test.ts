// ===========================================================================
// INVARIANT (Task T-B-EMP-TERMINATE-GUARD): TERMINATION IS FINAL. Once TERMINATED, an employee's
// status and termination date can no longer change — someone taken back on is a new employee
// record. A SUSPENDED employee stays reinstatable.
//
// The payroll service refuses with PayrollStateError (409 through PATCH /employees/:id/status);
// migration 0033's trigger `employee_terminated_final` is the guarantee, attacked here with raw SQL.
// On its own tenant, so the shared fixture's payroll runs never see these employees.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmployee, PayrollStateError, setEmployeeStatus } from "../../src/services/payroll";
import { dropTenant, provisionFixture, schemaOf, tenantDb, withTenantTx } from "../setup/tenant";
import { expectDbRefusal } from "../support/db-errors";

const TENANT = "qa-emp-final";
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  await dropTenant(TENANT);
  await provisionFixture(TENANT, "QA Employee Final");
});
afterAll(async () => {
  await dropTenant(TENANT);
});

async function hire(firstName: string) {
  return createEmployee(tenantDb(TENANT), { firstName, lastName: "Final", hireDate: day("2026-01-05"), basicSalary: 3000000n });
}

describe("termination is final", () => {
  it("a suspended employee can be reinstated", async () => {
    const e = await hire("Suspended");
    await setEmployeeStatus(tenantDb(TENANT), e.id, "SUSPENDED");
    const back = await setEmployeeStatus(tenantDb(TENANT), e.id, "ACTIVE");
    expect(back.status).toBe("ACTIVE");
  });

  it("the service refuses any status change of a terminated employee", async () => {
    const e = await hire("Terminated");
    await setEmployeeStatus(tenantDb(TENANT), e.id, "TERMINATED", day("2026-10-31"));
    for (const status of ["ACTIVE", "SUSPENDED"] as const) {
      await expect(setEmployeeStatus(tenantDb(TENANT), e.id, status)).rejects.toThrow(PayrollStateError);
    }
    await expect(setEmployeeStatus(tenantDb(TENANT), e.id, "TERMINATED", day("2026-11-30"))).rejects.toThrow(/termination is final/);
  });

  it("the database refuses reinstating or re-dating a terminated row — employee_terminated_final", async () => {
    const e = await hire("Raw");
    await setEmployeeStatus(tenantDb(TENANT), e.id, "TERMINATED", day("2026-10-31"));
    const schema = schemaOf(TENANT);
    await expectDbRefusal(
      withTenantTx(TENANT, (client) => client.query(`UPDATE "${schema}".employees SET "status" = 'ACTIVE', "terminationDate" = NULL WHERE "id" = $1`, [e.id])),
      { fn: "employee_terminated_final", message: /employee_terminated_final/ },
    );
    await expectDbRefusal(
      withTenantTx(TENANT, (client) => client.query(`UPDATE "${schema}".employees SET "terminationDate" = '2026-11-15' WHERE "id" = $1`, [e.id])),
      { fn: "employee_terminated_final" },
    );
  });

  it("control: a terminated employee's other fields still change, and an active one's status does", async () => {
    const e = await hire("Control");
    const schema = schemaOf(TENANT);
    await withTenantTx(TENANT, (client) => client.query(`UPDATE "${schema}".employees SET "status" = 'SUSPENDED' WHERE "id" = $1`, [e.id]));
    await setEmployeeStatus(tenantDb(TENANT), e.id, "TERMINATED", day("2026-10-31"));
    await withTenantTx(TENANT, (client) => client.query(`UPDATE "${schema}".employees SET "bankName" = 'KCB' WHERE "id" = $1`, [e.id]));
  });
});
