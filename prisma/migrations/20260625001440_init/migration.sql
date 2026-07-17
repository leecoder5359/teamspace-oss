-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "PageKind" AS ENUM ('doc', 'database');

-- CreateEnum
CREATE TYPE "PropType" AS ENUM ('text', 'number', 'date', 'select', 'multiselect', 'checkbox', 'person', 'relation');

-- CreateEnum
CREATE TYPE "ViewType" AS ENUM ('table', 'kanban');

-- CreateEnum
CREATE TYPE "NotifEvent" AS ENUM ('task_created', 'task_status', 'task_assigned', 'task_due');

-- CreateEnum
CREATE TYPE "NotifTarget" AS ENUM ('channel', 'dm');

-- CreateEnum
CREATE TYPE "ScheduleKind" AS ENUM ('once', 'cron');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('active', 'paused');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'editor',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Page" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "parentId" TEXT,
    "kind" "PageKind" NOT NULL DEFAULT 'doc',
    "title" TEXT NOT NULL DEFAULT 'Untitled',
    "icon" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "filePath" TEXT,
    "markdown" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DbProperty" (
    "id" TEXT NOT NULL,
    "databasePageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PropType" NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DbProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DbRow" (
    "id" TEXT NOT NULL,
    "databasePageId" TEXT NOT NULL,
    "props" JSONB NOT NULL DEFAULT '{}',
    "contentPageId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DbRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DbView" (
    "id" TEXT NOT NULL,
    "databasePageId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "type" "ViewType" NOT NULL DEFAULT 'table',
    "config" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DbView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackInstall" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "botTokenEnc" TEXT NOT NULL,
    "defaultChannelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackInstall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotifRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "event" "NotifEvent" NOT NULL,
    "target" "NotifTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotifRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "ScheduleKind" NOT NULL,
    "spec" TEXT NOT NULL,
    "template" JSONB NOT NULL DEFAULT '{}',
    "channelId" TEXT NOT NULL,
    "slackScheduledId" TEXT,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'active',
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "Page_workspaceId_parentId_idx" ON "Page"("workspaceId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "DbRow_contentPageId_key" ON "DbRow"("contentPageId");

-- CreateIndex
CREATE INDEX "DbRow_databasePageId_idx" ON "DbRow"("databasePageId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackInstall_workspaceId_key" ON "SlackInstall"("workspaceId");

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Page" ADD CONSTRAINT "Page_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Page" ADD CONSTRAINT "Page_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Page" ADD CONSTRAINT "Page_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DbProperty" ADD CONSTRAINT "DbProperty_databasePageId_fkey" FOREIGN KEY ("databasePageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DbRow" ADD CONSTRAINT "DbRow_databasePageId_fkey" FOREIGN KEY ("databasePageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DbRow" ADD CONSTRAINT "DbRow_contentPageId_fkey" FOREIGN KEY ("contentPageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DbView" ADD CONSTRAINT "DbView_databasePageId_fkey" FOREIGN KEY ("databasePageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackInstall" ADD CONSTRAINT "SlackInstall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotifRule" ADD CONSTRAINT "NotifRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
