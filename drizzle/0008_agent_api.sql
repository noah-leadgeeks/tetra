-- Down (manual): DROP INDEX agent_actions_pending_target_unique; DROP TABLE agent_actions; DROP TABLE api_tokens; DROP TYPE agent_action_status; ALTER TABLE users DROP COLUMN google_scopes; DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791800000000;
CREATE TYPE "public"."agent_action_status" AS ENUM('pending', 'executing', 'executed', 'failed', 'rejected', 'expired');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_scopes" text;--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{read}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_tokens_scopes_nonempty" CHECK (cardinality("api_tokens"."scopes") > 0)
);--> statement-breakpoint
CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_id" uuid,
	"kind" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"summary" jsonb NOT NULL,
	"reason" text,
	"status" "agent_action_status" DEFAULT 'executed' NOT NULL,
	"result" jsonb,
	"expires_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_actions_pending_expires" CHECK ("agent_actions"."status" <> 'pending' OR "agent_actions"."expires_at" IS NOT NULL),
	CONSTRAINT "agent_actions_executing_claimed" CHECK ("agent_actions"."status" <> 'executing' OR "agent_actions"."claimed_at" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_actions_user_status_idx" ON "agent_actions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "agent_actions_user_created_idx" ON "agent_actions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_actions_pending_target_unique" ON "agent_actions" USING btree ("user_id","target_type","target_id") WHERE "agent_actions"."status" = 'pending';
