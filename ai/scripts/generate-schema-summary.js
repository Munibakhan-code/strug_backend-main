import fs from 'fs';
import path from 'path';

const schemaPath = path.join(process.cwd(), 'prisma', 'schema.prisma');
const schemaContent = fs.readFileSync(schemaPath, 'utf8');

const models = {};
const modelRegex = /model\s+(\w+)\s+\{([\s\S]*?)\}/g;
let match;

while ((match = modelRegex.exec(schemaContent)) !== null) {
  const modelName = match[1];
  const body = match[2];
  const fields = [];
  
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;
    
    // Simple parser: [name] [type] [attributes...]
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const fieldName = parts[0];
      const fieldType = parts[1];
      fields.push(`${fieldName}: ${fieldType}`);
    }
  }
  models[modelName] = fields;
}

fs.writeFileSync(path.join(process.cwd(), 'ai', 'concise-schema.json'), JSON.stringify(models, null, 2));
console.log('Concise schema generated at ai/concise-schema.json');
