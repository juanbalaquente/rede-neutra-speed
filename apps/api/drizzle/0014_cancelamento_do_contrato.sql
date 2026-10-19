ALTER TABLE "contract_requests" ADD COLUMN "cancel_key" uuid;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD COLUMN "cancel_operation_id" text;--> statement-breakpoint
ALTER TABLE "contract_requests" ADD COLUMN "cancel_state" text;