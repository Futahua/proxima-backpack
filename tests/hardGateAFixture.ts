import { defineCanonicalRecordHeader, opaqueRecordIdFromRandomBytes, type CanonicalRecordHeader, type OpaqueRecordId } from '../src/domain/canonicalIdentity.js';
import type { CanonicalTaskStateRecord, CanonicalWorkflowStageStateRecord } from '../src/domain/canonicalTaskState.js';
function recordId(value:number):OpaqueRecordId{const b=new Uint8Array(16);b[15]=value;return opaqueRecordIdFromRandomBytes(b);}
export interface HardGateAEventFixture extends CanonicalRecordHeader<'event'>{readonly projectId:OpaqueRecordId;readonly startDate:string;readonly deadline:string;}
const project=defineCanonicalRecordHeader({kind:'project',id:recordId(1),name:'Combined project'});
const reviewStage:CanonicalWorkflowStageStateRecord={...defineCanonicalRecordHeader({kind:'workflow-stage',id:recordId(2),name:'Review'}),projectId:project.id};
const doneStage:CanonicalWorkflowStageStateRecord={...defineCanonicalRecordHeader({kind:'workflow-stage',id:recordId(3),name:'Done'}),projectId:project.id};
const task:CanonicalTaskStateRecord={...defineCanonicalRecordHeader({kind:'task',id:recordId(4),name:'Combined-project task'}),projectId:project.id,executionState:'running',workflowStageId:reviewStage.id};
const event:HardGateAEventFixture={...defineCanonicalRecordHeader({kind:'event',id:recordId(5),name:'Combined-project event'}),projectId:project.id,startDate:'2026-09-11T09:00:00.000Z',deadline:'2026-09-11T10:00:00.000Z'};
export const HARD_GATE_A_FIXTURE={combinedProject:{project,task,event},independentTaskMovement:{original:task,reviewStage,doneStage,executionMoved:{...task,executionState:'finished'},workflowMoved:{...task,workflowStageId:doneStage.id}}} as const;
