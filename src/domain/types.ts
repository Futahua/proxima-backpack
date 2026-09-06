/**
 * Proxima's own domain model.
 *
 * Nothing here may import Obsidian, Papers, Svelte or the filesystem. This is the
 * layer that survived the Obsidian plugin and must never again be reshaped to fit
 * whatever a host happens to support.
 */

export type TaskStatusId = string;
export type ProjectStatus = 'active' | 'archived';

/** Where a task sits on the Elastic board. Column membership is derived, never stored. */
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

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

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
  id: string;
  name: string;
  description: string;
  createdAt: string;
  status: ProjectStatus;
  /** 'task' projects appear on the Elastic board; 'schedule' projects appear on the calendar. */
  projectType: 'task' | 'schedule';
  archivedAt?: string;
  tabBgColor?: string;
  tabTextColor?: string;
  /** Vault-relative or machine paths the creator attached to this project. */
  linkedFolders: LinkedFolder[];
}

export interface LinkedFolder {
  name: string;
  path: string;
}

export interface Task {
  id: string;
  name: string;
  description: string;
  projectId: string | null;
  status: TaskStatusId;
  /** Relative pull on the elastic timeline. Higher weight claims more of the remaining time. */
  weight: number;
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
