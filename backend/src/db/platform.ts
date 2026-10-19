import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/platform/client";
import { pool } from "./pool";

const adapter = new PrismaPg(pool, { schema: "public" });

export const platformDb = new PrismaClient({ adapter });
