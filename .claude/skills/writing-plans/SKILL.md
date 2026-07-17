---
name: writing-plans
description: 이 프로젝트의 구현 계획 작성 진입점 — superpowers:writing-plans 대신 항상 이걸 사용. 스펙·요구사항이 확정된 멀티스텝 작업의 구현 계획을 쓸 때.
---

# 구현 계획 작성 (TeamSpace 오버라이드)

**superpowers:writing-plans 의 계획 작성 프로세스를 그대로 따르되, 저장·추적 단계만 이 프로젝트 규칙(AGENTS.md 4대 규칙)으로 대체한다.** superpowers:writing-plans 를 함께 로드해 계획 구조(단계 분해·검증 기준·태스크 단위)는 그쪽 지침대로 작성하라.

## 대체 단계

| superpowers 원본 | 이 프로젝트에서는 |
|---|---|
| 플랜을 `docs/superpowers/plans/*.md` 에 저장 | **TeamSpace doc 으로 저장**: `pnpm ws doc new "<topic> 구현 계획" --project <projectId>` → `PUT /api/pages/<id> {markdown}`. (레포 md 생성은 PreToolUse 훅이 차단한다.) |
| executing-plans 가 레포의 플랜 파일을 읽음 | 실행 세션은 `GET /api/pages/<id>` 로 플랜 본문을 읽는다. 필요하면 스크래치패드 디렉토리(임시 경로는 훅 허용)에 사본을 내려 작업한다. |
| 플랜 내 태스크를 내장 todo 로 추적 | 플랜의 각 태스크를 **TeamSpace 보드 태스크**로 등록하고 진행/완료 상태를 갱신한다. |
