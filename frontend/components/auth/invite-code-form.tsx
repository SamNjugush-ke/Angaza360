"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useId } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { TextField } from "./form-bits";

// The invitation message carries a CODE. Typing it here opens that invitation's accept page.

const codeSchema = z.object({ code: z.string().trim().min(1, "Enter the invitation code from your message.") });
type CodeValues = z.infer<typeof codeSchema>;

export function InviteCodeForm() {
  const router = useRouter();
  const id = useId();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CodeValues>({ resolver: zodResolver(codeSchema), defaultValues: { code: "" } });

  return (
    <form noValidate onSubmit={handleSubmit(({ code }) => router.push(`/invite/${encodeURIComponent(code.trim())}`))} className="space-y-5">
      <TextField
        id={id}
        label="Invitation code"
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck={false}
        error={errors.code?.message}
        {...register("code")}
      />
      <Button type="submit" className="h-11 w-full" disabled={isSubmitting}>
        Continue
      </Button>
    </form>
  );
}
