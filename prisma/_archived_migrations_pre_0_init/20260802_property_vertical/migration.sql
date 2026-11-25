-- Add a vertical discriminator to property so the Real Estate and Preconstruction
-- feeds can be isolated (#197). NULL = legacy rows, read as 'realestate'.
ALTER TABLE property ADD COLUMN IF NOT EXISTS vertical VARCHAR(40);
