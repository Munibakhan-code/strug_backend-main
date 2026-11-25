-- Add logo_url to food_vendor for store cover photo
ALTER TABLE food_vendor ADD COLUMN IF NOT EXISTS logo_url VARCHAR(1000);
