type PreflightStatus = 'pass' | 'fail' | 'warn' | 'not_checked';
type PreflightOverallStatus = 'pass' | 'fail' | 'warn';

interface SanitizedPreflightCheck {
  name: string;
  status: PreflightStatus;
  code?: string;
  message: string;
  durationMs: number;
}

interface SanitizedPreflightResult {
  overall: PreflightOverallStatus;
  checks: SanitizedPreflightCheck[];
  timestamp: string;
}

const PUBLIC_CHECK_NAMES: Record<string, string> = {
  encryption_master_key: 'data_protection',
  required_env_vars: 'service_configuration',
  llm_credentials: 'model_credentials',
  provider_key_match: 'model_configuration',
  provider_model_availability: 'model_configuration',
  runtime_reachable: 'agent_service_connectivity',
  runtime_auth: 'agent_service_authorization',
  clickhouse: 'results_storage',
  judge_token_split_schema: 'usage_telemetry',
  voice_runner: 'voice_eval_execution',
};

const DEFAULT_MESSAGES: Record<PreflightStatus, string> = {
  pass: 'System readiness check passed.',
  fail: 'System readiness check needs attention before evals can run.',
  warn: 'System readiness check should be reviewed before evals run.',
  not_checked: 'System readiness check was not completed.',
};

const CHECK_MESSAGES: Record<string, Record<PreflightStatus, string>> = {
  data_protection: {
    pass: 'Data protection settings are ready.',
    fail: 'Data protection settings need attention before evals can run.',
    warn: 'Data protection settings should be reviewed before evals run.',
    not_checked: 'Data protection settings were not checked.',
  },
  service_configuration: {
    pass: 'Required service configuration is ready.',
    fail: 'Required service configuration needs attention before evals can run.',
    warn: 'Required service configuration should be reviewed before evals run.',
    not_checked: 'Required service configuration was not checked.',
  },
  model_credentials: {
    pass: 'Model credentials are ready.',
    fail: 'Model credentials need attention before evals can run.',
    warn: 'Model credentials should be reviewed before evals run.',
    not_checked: 'Model credentials were not checked.',
  },
  model_configuration: {
    pass: 'Model configuration is compatible.',
    fail: 'Model configuration needs attention before evals can run.',
    warn: 'Model configuration should be reviewed before evals run.',
    not_checked: 'Model configuration was not checked.',
  },
  agent_service_connectivity: {
    pass: 'Agent service is reachable.',
    fail: 'Agent service connectivity needs attention before evals can run.',
    warn: 'Agent service connectivity should be reviewed before evals run.',
    not_checked: 'Agent service connectivity was not checked.',
  },
  agent_service_authorization: {
    pass: 'Agent service authorization is ready.',
    fail: 'Agent service authorization needs attention before evals can run.',
    warn: 'Agent service authorization should be reviewed before evals run.',
    not_checked: 'Agent service authorization was not checked.',
  },
  results_storage: {
    pass: 'Eval results storage is ready.',
    fail: 'Eval results storage needs attention before evals can run.',
    warn: 'Eval results storage should be reviewed before evals run.',
    not_checked: 'Eval results storage was not checked.',
  },
  usage_telemetry: {
    pass: 'Usage telemetry is ready.',
    fail: 'Usage telemetry needs attention before evals can run.',
    warn: 'Usage telemetry should be reviewed before evals run.',
    not_checked: 'Usage telemetry was not checked.',
  },
  voice_eval_execution: {
    pass: 'Voice eval execution is ready.',
    fail: 'Voice eval execution needs attention before voice evals can run.',
    warn: 'Voice eval execution should be reviewed before voice evals run.',
    not_checked: 'Voice eval execution was not checked.',
  },
};

const CODE_MESSAGES: Record<string, Partial<Record<PreflightStatus, string>>> = {
  MISSING_PROVIDER_KEY: {
    fail: 'Model credentials are missing for the selected provider.',
  },
  PROVIDER_MODEL_RETIRED: {
    fail: 'The selected evaluator model is retired; choose a supported model.',
  },
  RUNTIME_PREFLIGHT_CIRCUIT_OPEN: {
    warn: 'Agent service readiness probing is temporarily deferred; verify Runtime health and retry.',
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStatus(value: unknown): PreflightStatus {
  if (value === 'pass' || value === 'fail' || value === 'warn' || value === 'not_checked') {
    return value;
  }
  return 'not_checked';
}

function sanitizeCheckName(rawName: unknown): string {
  if (typeof rawName !== 'string') {
    return 'system_check';
  }

  const evaluatorMatch = /^evaluator_model_(\d+)$/.exec(rawName);
  if (evaluatorMatch) {
    return `evaluator_model_configuration_${evaluatorMatch[1]}`;
  }

  return PUBLIC_CHECK_NAMES[rawName] ?? 'system_check';
}

function getSanitizedMessage(name: string, status: PreflightStatus): string {
  if (name.startsWith('evaluator_model_configuration_')) {
    if (status === 'pass') return 'Evaluator model configuration is ready.';
    if (status === 'fail') {
      return 'Evaluator model configuration needs attention before evals can run.';
    }
    if (status === 'warn')
      return 'Evaluator model configuration should be reviewed before evals run.';
    return 'Evaluator model configuration was not checked.';
  }

  return CHECK_MESSAGES[name]?.[status] ?? DEFAULT_MESSAGES[status];
}

function sanitizeCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) return undefined;
  return value;
}

function normalizeDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value);
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return new Date().toISOString();
}

function normalizeOverall(
  value: unknown,
  checks: SanitizedPreflightCheck[],
): PreflightOverallStatus {
  if (value === 'pass' || value === 'fail' || value === 'warn') {
    return value;
  }

  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn' || check.status === 'not_checked')) {
    return 'warn';
  }
  return 'pass';
}

function sanitizePreflightCheck(value: unknown): SanitizedPreflightCheck {
  const check = isRecord(value) ? value : {};
  const status = normalizeStatus(check.status);
  const name = sanitizeCheckName(check.name);
  const code = sanitizeCode(check.code);
  const codeMessage = code ? CODE_MESSAGES[code]?.[status] : undefined;

  return {
    name,
    status,
    ...(code ? { code } : {}),
    message: codeMessage ?? getSanitizedMessage(name, status),
    durationMs: normalizeDuration(check.durationMs),
  };
}

function sanitizeEvalPreflightResult(value: unknown): SanitizedPreflightResult {
  const result = isRecord(value) ? value : {};
  const checks = Array.isArray(result.checks) ? result.checks.map(sanitizePreflightCheck) : [];

  return {
    overall: normalizeOverall(result.overall, checks),
    checks,
    timestamp: normalizeTimestamp(result.timestamp),
  };
}

export function sanitizeEvalPreflightResponse(value: unknown): unknown {
  if (!isRecord(value)) {
    return sanitizeEvalPreflightResult(value);
  }

  if ('result' in value) {
    return {
      ...value,
      result: sanitizeEvalPreflightResult(value.result),
    };
  }

  return sanitizeEvalPreflightResult(value);
}
