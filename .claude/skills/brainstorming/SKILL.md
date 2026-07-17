---
name: brainstorming
description: 이 프로젝트의 브레인스토밍 진입점 — superpowers:brainstorming 대신 항상 이걸 사용. 기능 설계·요구사항 탐색 전 아이디어를 설계로 다듬을 때. (creating features, building components, adding functionality, or modifying behavior 전에)
---

# 브레인스토밍 (TeamSpace 오버라이드)

**superpowers:brainstorming 의 프로세스를 그대로 따르되, 아래 단계만 이 프로젝트 규칙(AGENTS.md 4대 규칙)으로 대체한다.** superpowers:brainstorming 스킬을 함께 로드해 질문·접근안·설계 프로세스는 그쪽 지침대로 진행하라.

## 대체 단계

| superpowers 원본 | 이 프로젝트에서는 |
|---|---|
| 스펙을 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` 에 저장 + git 커밋 | **TeamSpace doc 으로 저장**: `pnpm ws doc new "<topic> 설계" --project <projectId>` → `PUT /api/pages/<id> {markdown}`. git 커밋 단계는 없음(레포 md 생성은 PreToolUse 훅이 차단한다). |
| 설계/스펙 승인을 채팅으로 대기 | 사용자가 채팅에 실시간 참여 중이면 채팅, 아니면 **Slack `#workspace-confirm` 컨펌**(`scripts/slack-confirm.ts` 발송 후 답글 폴링). |
| 확정 사항 기록 없음 | 방향을 가르는 결정은 `POST /api/decisions` 에 `accepted` 로 등록. |
| 내장 todo 로 체크리스트 관리 | 작업 슬라이스는 **TeamSpace 보드 태스크**로 생성·완료 처리(내장 todo 는 보조). |

## 이후 단계

설계 승인 후 구현 계획이 필요하면 로컬 `writing-plans` 오버라이드 스킬을 사용한다(플랜도 TeamSpace doc).
