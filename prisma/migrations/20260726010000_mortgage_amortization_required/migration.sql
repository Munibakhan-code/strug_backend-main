-- Bug #5: make amortization_years required on New Purchase mortgage form schema.
UPDATE "quote_category"
SET "form_schema" = (
  SELECT jsonb_agg(
    CASE
      WHEN elem->>'key' = 'amortization_years'
        THEN elem || '{"required": true}'::jsonb
      ELSE elem
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements("form_schema") WITH ORDINALITY AS t(elem, ord)
)
WHERE "slug" = 'mortgage-new-purchase'
  AND "form_schema" IS NOT NULL
  AND jsonb_typeof("form_schema") = 'array';
