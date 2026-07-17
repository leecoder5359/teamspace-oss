// DbProperty.config 런타임 검증 (PLAN §9.1)
// config 컬럼은 Json(JSONB) blob 이라 컴파일타임 타입 보장이 없어,
// multiselect / person 두 타입에 한해 Zod 로 형태를 검증한다.
// person 의 멤버 참조는 WorkspaceMember.id 를 가리킨다.
import { z } from "zod";

// select / multiselect 공용 옵션 (DatabaseView.tsx 의 SelectOption 과 동일 형태)
export const selectOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.string(),
});
export type SelectOption = z.infer<typeof selectOptionSchema>;

// multiselect: select 와 동일하게 options 목록을 가진다.
export const multiselectConfigSchema = z.object({
  options: z.array(selectOptionSchema).default([]),
});
export type MultiselectConfig = z.infer<typeof multiselectConfigSchema>;

// person: 선택 가능한 멤버를 제한할 때 사용 (WorkspaceMember.id 참조).
// 비어있으면 워크스페이스 전체 멤버를 후보로 본다.
export const personConfigSchema = z.object({
  memberIds: z.array(z.string().min(1)).optional(),
});
export type PersonConfig = z.infer<typeof personConfigSchema>;

const CONFIG_VALIDATORS = {
  multiselect: multiselectConfigSchema,
  person: personConfigSchema,
} as const;

export type ValidatedPropType = keyof typeof CONFIG_VALIDATORS;

/**
 * 주어진 속성 타입에 대해 config 를 검증한다.
 * 검증기가 없는 타입(text/number/date/select/checkbox/relation)은 입력을 그대로 통과시킨다.
 * 비파괴적: 검증 실패 시 throw 하므로 호출부에서 safeParse 또는 try/catch 로 다룰 것.
 */
export function parseDbPropertyConfig(type: string, config: unknown): unknown {
  const validator = CONFIG_VALIDATORS[type as ValidatedPropType];
  if (!validator) return config;
  return validator.parse(config ?? {});
}

/** throw 하지 않는 검증. 실패 시 success:false 와 에러를 돌려준다. */
export function safeParseDbPropertyConfig(type: string, config: unknown) {
  const validator = CONFIG_VALIDATORS[type as ValidatedPropType];
  if (!validator) return { success: true as const, data: config };
  return validator.safeParse(config ?? {});
}
