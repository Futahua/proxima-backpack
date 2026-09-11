export const CANONICAL_DOMAIN_SCHEMA_VERSION = 2 as const;
export type DomainInformationAuthority = 'canonical-record-data' | 'backpack-local-state' | 'external-artifact-reference';
export type DomainInformationDurability = 'durable' | 'disposable';
export interface DomainInformationClassification { readonly authority: DomainInformationAuthority; readonly durability: DomainInformationDurability; readonly domainSemantic: boolean; }
const CANONICAL: DomainInformationClassification = { authority:'canonical-record-data', durability:'durable', domainSemantic:true };
const LOCAL: DomainInformationClassification = { authority:'backpack-local-state', durability:'disposable', domainSemantic:false };
const EXTERNAL: DomainInformationClassification = { authority:'external-artifact-reference', durability:'durable', domainSemantic:false };
export const DOMAIN_INFORMATION_CLASSIFICATION = {
 'record.identity-and-kind':CANONICAL,'record.human-name':CANONICAL,'task.project-membership':CANONICAL,'task.execution-state':CANONICAL,'task.workflow-stage':CANONICAL,'task.execution-order':CANONICAL,'task.workflow-order':CANONICAL,'task.temporal-and-property-data':CANONICAL,'project.lifecycle-and-domain-fields':CANONICAL,'project.artifact-bindings':CANONICAL,'event.project-membership':CANONICAL,'event.temporal-and-property-data':CANONICAL,'workflow-stage.definition':CANONICAL,'schema.definition':CANONICAL,'schema.option-identity':CANONICAL,'relation.value':CANONICAL,'recurrence.series-rule-and-exceptions':CANONICAL,
 'cockpit.navigation-and-selection':LOCAL,'view.search-filter-sort':LOCAL,'gantt.row-placement':LOCAL,'schema.presentation':LOCAL,'interaction.provisional-gesture':LOCAL,'editor.unsaved-draft':LOCAL,
 'vault.note-content':EXTERNAL,'vault.drawing-content':EXTERNAL,'vault.attachment-content':EXTERNAL,'external-artifact.identity-and-locator':EXTERNAL,'legacy-import.provenance-and-aliases':EXTERNAL,
} as const satisfies Record<string, DomainInformationClassification>;
export type DomainInformationKey = keyof typeof DOMAIN_INFORMATION_CLASSIFICATION;
export function classificationForDomainInformation(key: DomainInformationKey): DomainInformationClassification { return DOMAIN_INFORMATION_CLASSIFICATION[key]; }
