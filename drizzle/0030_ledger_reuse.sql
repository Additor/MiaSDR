ALTER TABLE "grid_cell_runs" ADD COLUMN "lookup_key" text;--> statement-breakpoint
ALTER TABLE "grid_cell_runs" ADD COLUMN "answer" jsonb;--> statement-breakpoint
ALTER TABLE "grid_cell_runs" ADD COLUMN "reused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "grid_cell_runs_lookup_idx" ON "grid_cell_runs" USING btree ("organization_id","lookup_key","created_at") WHERE "grid_cell_runs"."lookup_key" is not null;