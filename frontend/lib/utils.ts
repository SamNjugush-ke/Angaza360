import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names and resolves Tailwind conflicts (the last utility wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
