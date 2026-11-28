import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { zAccount, zAccountClass } from "../schemas/models";
import { errorResponses, notFound, SECURE, zAccountCodeParam } from "../schemas/common";

// Read-only Chart of Accounts endpoints. There is deliberately no
// POST/PATCH/DELETE in this task — custom account creation and the rules around
// editing a chart that already has postings arrive with the ledger in Task 2.2.

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const guards = [
    app.requireAuth,
    app.requireTenant,
    app.requireRole("MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "VIEWER_AUDITOR"),
  ];

  api.route({
    method: "GET",
    url: "/",
    preHandler: guards,
    schema: {
      tags: ["Ledger"],
      summary: "List the chart of accounts",
      description:
        "The tenant's IFRS-classified chart of accounts, ordered by code. Optionally filtered to one account class.",
      security: SECURE,
      querystring: z.object({
        class: zAccountClass.optional().meta({
          description: "Filter to a single account class.",
        }),
      }),
      response: {
        200: z.object({ data: z.array(zAccount), count: z.number().int() }),
        ...errorResponses(400, 401, 403),
      },
    },
    handler: async (request, reply) => {
      const { class: accountClass } = request.query;
      const data = await request.tenantDb.account.findMany({
        where: accountClass === undefined ? undefined : { accountClass },
        orderBy: { code: "asc" },
      });
      return reply.code(200).send({ data, count: data.length });
    },
  });

  api.route({
    method: "GET",
    url: "/:code",
    preHandler: guards,
    schema: {
      tags: ["Ledger"],
      summary: "Get one account by code",
      security: SECURE,
      params: zAccountCodeParam,
      response: {
        200: zAccount,
        ...errorResponses(401, 403, 404),
      },
    },
    handler: async (request, reply) => {
      const { code } = request.params;
      const account = await request.tenantDb.account.findUnique({ where: { code } });
      if (account === null) {
        return reply.code(404).send(notFound(`No account with code "${code}".`));
      }
      return reply.code(200).send(account);
    },
  });
}
