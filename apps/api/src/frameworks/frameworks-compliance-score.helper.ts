const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

interface ControlForScoring {
  id: string;
  policies: { id: string; status: string }[];
  controlDocumentTypes?: { formType: string; isNotRelevant?: boolean }[];
}

interface FrameworkWithControlsForScoring {
  controls: ControlForScoring[];
}

interface TaskWithControls {
  id: string;
  status: string;
  controls: { id: string }[];
}

interface EvidenceSubmissionForScoring {
  formType: string;
  submittedAt: Date | string;
}

export function computeFrameworkComplianceScore(
  framework: FrameworkWithControlsForScoring,
  tasks: TaskWithControls[],
  evidenceSubmissions: EvidenceSubmissionForScoring[] = [],
): number {
  const controls = framework.controls ?? [];
  if (controls.length === 0) return 0;

  const controlIds = new Set(controls.map((control) => control.id));

  // Weight every unique artifact equally so partially completed controls
  // still contribute progress.
  const policiesById = new Map<string, { id: string; status: string }>();
  for (const control of controls) {
    for (const policy of control.policies ?? []) {
      policiesById.set(policy.id, policy);
    }
  }

  const tasksById = new Map<string, TaskWithControls>();
  for (const task of tasks) {
    if (task.controls.some((control) => controlIds.has(control.id))) {
      tasksById.set(task.id, task);
    }
  }

  const documentFormTypes = new Set<string>();
  for (const control of controls) {
    for (const documentType of control.controlDocumentTypes ?? []) {
      if (documentType.isNotRelevant === true) continue;
      documentFormTypes.add(documentType.formType);
    }
  }

  const totalArtifacts =
    policiesById.size + tasksById.size + documentFormTypes.size;
  if (totalArtifacts === 0) return 0;

  const policiesCompleted = Array.from(policiesById.values()).filter(
    (policy) => policy.status === 'published',
  ).length;
  const tasksCompleted = Array.from(tasksById.values()).filter(
    (task) => task.status === 'done' || task.status === 'not_relevant',
  ).length;

  let documentsCompleted = 0;
  if (documentFormTypes.size > 0 && evidenceSubmissions.length > 0) {
    const sorted = [...evidenceSubmissions].sort(
      (a, b) =>
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
    );
    const now = Date.now();
    for (const formType of documentFormTypes) {
      const latest = sorted.find(
        (submission) => submission.formType === formType,
      );
      if (
        latest &&
        now - new Date(latest.submittedAt).getTime() <= SIX_MONTHS_MS
      ) {
        documentsCompleted++;
      }
    }
  }

  const completed = policiesCompleted + tasksCompleted + documentsCompleted;
  return Math.round((completed / totalArtifacts) * 100);
}

export function computeFrameworkReadinessProgressScore(
  framework: FrameworkWithControlsForScoring,
  tasks: TaskWithControls[],
): number {
  const controls = framework.controls ?? [];
  if (controls.length === 0) return 0;

  const controlIds = new Set(controls.map((control) => control.id));
  const policiesById = new Map<string, { id: string; status: string }>();
  for (const control of controls) {
    for (const policy of control.policies ?? []) {
      policiesById.set(policy.id, policy);
    }
  }

  const tasksById = new Map<string, TaskWithControls>();
  for (const task of tasks) {
    if (task.controls.some((control) => controlIds.has(control.id))) {
      tasksById.set(task.id, task);
    }
  }

  const totalArtifacts = policiesById.size + tasksById.size;
  if (totalArtifacts === 0) return 0;

  const policyProgress = Array.from(policiesById.values()).reduce(
    (sum, policy) => {
      if (policy.status === 'published') return sum + 1;
      if (policy.status === 'needs_review') return sum + 0.75;
      if (policy.status === 'draft') return sum + 0.5;
      return sum;
    },
    0,
  );

  const taskProgress = Array.from(tasksById.values()).reduce((sum, task) => {
    if (task.status === 'done' || task.status === 'not_relevant') {
      return sum + 1;
    }
    if (task.status === 'in_review') return sum + 0.9;
    if (task.status === 'in_progress') return sum + 0.75;
    if (task.status === 'todo') return sum + 0.5;
    return sum;
  }, 0);

  return Math.round(((policyProgress + taskProgress) / totalArtifacts) * 100);
}
