import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { parseMoneyToCents } from "../lib/money";
import { zCustomer } from "../schemas/models";
import {
  conflict,
  errorResponses,
  notFound,
  SECURE,
  zIdParam,
  zMoneyNonNegative,
} from "../schemas/common";

// Customer CRUD. creditBalance is NOT settable here — it is moved only by the
// sale service (a CREDIT tender raises it, a void lowers it). creditLimit is an
// admin figure and may be set by owners/managers.

// Nullable-optional contact fields: absent means "leave alone" on PATCH, while
// an explicit empty string clears the column (the pre-existing behaviour of
// optionalString(...) ?? null).
const zContactField = z.string().optional();

function orNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

const zCustomerCreate = z.object({
  name: z.string().trim().min(1, "name is required."),
  phone: zContactField,
  email: zContactField,
  kraPin: zContactField,
  creditLimit: zMoneyNonNegative.optional(),
});

const zCustomerUpdate = z.object({
  name: z.string().trim().min(1, "name must be a non-empty string.").optional(),
  phone: zContactField,
  email: zContactField,
  kraPin: zContactField,
  creditLimit: zMoneyNonNegative.optional(),
  isActive: z.boolean().optional(),
});

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const base = [app.requireAuth, app.requireTenant];
  const readWriteRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER", "CASHIER");
  const updateRoles = app.requireRole("MSME_OWNER", "MSME_MANAGER");

  api.route({
    method: "GET",
    url: "/",
    preHandler: [...base, readWriteRoles],
    schema: {
      tags: ["Customers"],
      summary: "List customers",
      description:
        "All customers, by name. creditLimit and creditBalance are strings of KES cents.",
      security: SECURE,
      response: {
        200: z.object({ data: z.array(zCustomer) }),
        ...errorResponses(401, 403),
      },
    },
    handler: async (request, reply) => {
      const customers = await request.tenantDb.customer.findMany({ orderBy: { name: "asc" } });
      return reply.code(200).send({ data: customers });
    },
  });

  api.route({
    method: "GET",
    url: "/:id",
    preHandler: [...base, readWriteRoles],
    schema: {
      tags: ["Customers"],
      summary: "Get one customer",
      security: SECURE,
      params: zIdParam,
      response: { 200: zCustomer, ...errorResponses(401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const customer = await request.tenantDb.customer.findUnique({ where: { id } });
      if (customer === null) {
        return reply.code(404).send(notFound(`No customer with id "${id}".`));
      }
      return reply.code(200).send(customer);
    },
  });

  api.route({
    method: "POST",
    url: "/",
    preHandler: [...base, readWriteRoles],
    schema: {
      tags: ["Customers"],
      summary: "Create a customer",
      description:
        "creditLimit is a decimal string (e.g. \"5000.00\"). creditBalance cannot be set here — only a sale or a void moves it.",
      security: SECURE,
      body: zCustomerCreate,
      response: { 201: zCustomer, ...errorResponses(400, 401, 403, 409) },
    },
    handler: async (request, reply) => {
      const body = request.body;
      try {
        const created = await request.tenantDb.customer.create({
          data: {
            name: body.name,
            phone: orNull(body.phone),
            email: orNull(body.email),
            kraPin: orNull(body.kraPin),
            creditLimit:
              body.creditLimit === undefined ? 0n : parseMoneyToCents(body.creditLimit),
          },
        });
        return reply.code(201).send(created);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send(conflict("A customer with that phone already exists."));
        }
        throw error;
      }
    },
  });

  api.route({
    method: "PATCH",
    url: "/:id",
    preHandler: [...base, updateRoles],
    schema: {
      tags: ["Customers"],
      summary: "Update a customer",
      description:
        "Only the supplied fields change. creditBalance is never settable here.",
      security: SECURE,
      params: zIdParam,
      body: zCustomerUpdate,
      response: { 200: zCustomer, ...errorResponses(400, 401, 403, 404) },
    },
    handler: async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      const data: {
        name?: string;
        phone?: string | null;
        email?: string | null;
        kraPin?: string | null;
        creditLimit?: bigint;
        isActive?: boolean;
      } = {};
      if (body.name !== undefined) {
        data.name = body.name;
      }
      if (body.phone !== undefined) {
        data.phone = orNull(body.phone);
      }
      if (body.email !== undefined) {
        data.email = orNull(body.email);
      }
      if (body.kraPin !== undefined) {
        data.kraPin = orNull(body.kraPin);
      }
      if (body.creditLimit !== undefined) {
        data.creditLimit = parseMoneyToCents(body.creditLimit);
      }
      if (body.isActive !== undefined) {
        data.isActive = body.isActive;
      }

      const existing = await request.tenantDb.customer.findUnique({ where: { id } });
      if (existing === null) {
        return reply.code(404).send(notFound(`No customer with id "${id}".`));
      }
      const updated = await request.tenantDb.customer.update({ where: { id }, data });
      return reply.code(200).send(updated);
    },
  });
}
