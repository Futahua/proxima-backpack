/**
 * Proxima's own domain model.
 *
 * Nothing here may import Obsidian, Papers, Svelte or the filesystem. This is the
 * layer that survived the Obsidian plugin and must never again be reshaped to fit
 * whatever a host happens to support.
 */

import type { SourceRef } from './records.js';

/**
 * Legacy Markdown compatibility status id.
 *
 * This remains part of the pre-record-store reader only. Future canonical tasks do not
 * share one status concept between Elastic execution and project workflow: HARD GATE A /
 * A2 gives them independent executionState and workflowStageId fields.
 */
export type TaskStatusId = string;
export type ProjectStatus = 'active' | 'archived';

/** Where a legacy task appears on the current Elastic board. */
export type ElasticColumn = 'backlog' | 'running' | 'finished';

export type PropertyType =
  | 'text'
  | 'number'
  | 'select'
  | 'multi-select'
  | 'date'
  | 'checkbox'
  | 'relation'
  | 'rollup'
  | 'formula';

/**
 * Legacy pre-record-store schema option.
 *
 * `color` belongs to the old compatibility/presentation model. HARD GATE A / A5
 * defines stable canonical option identity separately from local presentation.
 */
export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

/**
 * Legacy pre-record-store property-schema shape.
 *
 * This remains available to existing compatibility code only. It is not the future
 * canonical schema record: in particular `targetFolder`, display color and the
 * unbranded string ids must not become canonical schema semantics.
 */
export interface PropertySchema {
  id: string;
  name: string;
  type: PropertyType;
  options?: SelectOption[];
  targetFolder?: string;
  relationProperty?: string;
  targetProperty?: string;
  aggregation?: 'sum' | 'average' | 'count' | 'unique' | 'min' | 'max';
  expression?: string;
}

export interface Project {
  /** Logical identity. Never the file path — see `SourceRef` for where it came from. */
  id: string;
  source: SourceRef;
  name: string;
  description: string;
  createdAt: string;
  status: ProjectStatus;
  /**
   * Legacy Markdown import/presentation metadata only.
   *
   * HARD GATE A / A4 removes this field from capability and visibility decisions.
   * A project may simultaneously own tasks and events regardless of this old label.
   */
  projectType: 'task' | 'schedule';
  archivedAt?: string;
  tabBgColor?: string;
  tabTextColor?: string;
  /** Vault-relative or machine paths the creator attached to this project. */
  /**
   * Legacy Markdown compatibility association.
   *
   * HARD GATE A / A8 does not promote these paths into canonical project identity.
   * Future project/filesystem association uses explicit external-artifact references.
   */
  linkedFolders: LinkedFolder[];
}

export interface LinkedFolder {
  name: string;
  path: string;
}

export interface Task {
  id: string;
  source: SourceRef;
  name: string;
  description: string;
  projectId: string | null;
  /** Legacy compatibility status. Not the future canonical execution/workflow model. */
  status: TaskStatusId;
  /** Relative pull on the elastic timeline. Higher weight claims more of the remaining time. */
  weight: number;
  /**
   * Legacy Markdown compatibility order.
   *
   * HARD GATE A / A3 does not promote this universal value into the future
   * canonical model. Canonical Elastic and workflow ordering have independent,
   * explicitly scoped positions.
   */
  orderIndex: number;
  isFixedDuration: boolean;
  /** Minutes. Only meaningful when isFixedDuration is true. */
  fixedDuration: number | null;
  /** Minutes. Caps how far an elastic task may stretch. */
  maxDuration: number | null;
  isCompleted: boolean;
  createdAt: string;
  startDate: string | null;
  deadline: string | null;
  properties: Record<string, unknown>;
}

export interface CalendarEvent {
  id: string;
  source: SourceRef;
  name: string;
  description: string;
  projectId: string | null;
  createdAt: string;
  startDate: string;
  deadline: string;
  isCompleted: boolean;
  properties: Record<string, unknown>;
}

/** One task's computed slice of the elastic timeline. */
export interface TimelineSlice {
  taskId: string;
  startTime: string;
  endTime: string;
  /** Minutes. */
  duration: number;
}

/** Legacy compatibility mapping from one Markdown status to an Elastic column. */
export interface StatusDefinition {
  id: TaskStatusId;
  name: string;
  color: string;
  column: ElasticColumn;
}

export interface ColorRule {
  id: string;
  targetDate: 'deadline' | 'createdAt';
  condition: 'is relative to today';
  value: 'overdue' | 'today' | 'next 2 days' | 'next 3 days' | 'next week' | 'next month';
  color: string;
}

export interface FilterRule {
  id: string;
  property: string;
  operator: 'is' | 'is-not' | 'contains' | 'not-contains' | 'gt' | 'lt' | 'is-empty' | 'not-empty';
  value: unknown;
}

/** The whole readable world, as one value. Everything the UI renders derives from this. */
export interface ProximaState {
  projects: Project[];
  tasks: Task[];
  events: CalendarEvent[];
  statuses: StatusDefinition[];
  taskSchema: PropertySchema[];
}

export const EMPTY_STATE: ProximaState = {
  projects: [],
  tasks: [],
  events: [],
  statuses: [],
  taskSchema: [],
};
