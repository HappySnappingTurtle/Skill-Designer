export function SkillId({ value, className = "" }: { value: string; className?: string }) {
  return <code className={`skill-id-code ${className}`.trim()} title={value} data-skill-id={value}>{compactSkillId(value)}</code>;
}

function compactSkillId(value: string): string {
  return value.length > 30 ? `${value.slice(0, 18)}…${value.slice(-8)}` : value;
}
