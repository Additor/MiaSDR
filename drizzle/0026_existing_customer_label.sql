-- The reply subcategory `customer` reads "Existing customer", so it does not read as a CRM contact or a Won deal.
-- Only rows that still carry the seeded name change; a name a person chose stays.
UPDATE "subcategories" SET "name" = 'Existing customer' WHERE "key" = 'customer' AND "name" = 'Customer';
