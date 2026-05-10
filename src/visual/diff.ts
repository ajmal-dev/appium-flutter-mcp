/**
 * Visual diff types for the Visual AI Test Oracle.
 */

export interface VisualStep {
  seq: number;
  actionType: string;
  description: string;
  screenshot: string; // base64 JPEG
  timestamp: string;
  interactiveElements?: Array<{
    type: string;
    text?: string;
    locator: { by: string; value: string };
    position?: { x: number; y: number; width: number; height: number };
  }>;
}

export interface VisualBaseline {
  recordingId: string;
  recordingName: string;
  platform: string;
  createdAt: string;
  steps: VisualStep[];
}

export interface StructuralChange {
  type: 'element_missing' | 'element_added' | 'element_moved' | 'text_changed' | 'count_changed';
  element?: string;
  details: string;
  severity: 'low' | 'medium' | 'high';
}

export interface VisualDiff {
  step: number;
  status: 'pass' | 'warning' | 'fail';
  structuralChanges: StructuralChange[];
  confidence: number;
  summary: string;
}

export interface VisualReport {
  baselineId: string;
  baselineName: string;
  timestamp: string;
  totalSteps: number;
  passed: number;
  warnings: number;
  failed: number;
  diffs: VisualDiff[];
}
