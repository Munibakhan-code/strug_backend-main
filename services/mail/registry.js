/**
 * Re-export template registry next to the mail module (SSOT remains scripts/).
 * Add a mail: template → locale keys → registry row → mailer / mailerEvents.
 */
export {
  EMAIL_TEMPLATE_REGISTRY,
  sampleVariablesForTemplate,
  logEmailTemplateInventory,
} from '../../scripts/email-template-registry.js';
