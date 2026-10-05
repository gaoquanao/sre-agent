/** Navigation registry: single source of truth for the sidebar and the routes. */
import type { ReactNode } from 'react'
import {
  AlertOutlined,
  ApiOutlined,
  BookOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  ExperimentOutlined,
  LockOutlined,
  MessageOutlined,
  PartitionOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import ChatPage from './pages/ChatPage'
import ApprovalsPage from './pages/ApprovalsPage'
import InspectionPage from './pages/InspectionPage'
import AlertsPage from './pages/AlertsPage'
import SkillsPage from './pages/SkillsPage'
import McpPage from './pages/McpPage'
import ModelsPage from './pages/ModelsPage'
import PermissionsPage from './pages/PermissionsPage'
import KnowledgePage from './pages/KnowledgePage'
import MemoryPage from './pages/MemoryPage'
import WorkflowsPage from './pages/WorkflowsPage'
import AgentsPage from './pages/AgentsPage'
import KernelsPage from './pages/KernelsPage'

export interface NavItem {
  key: string
  path: string
  label: string
  icon: ReactNode
  element: ReactNode
  /** Short description used in the page header. */
  hint?: string
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'chat', path: '/', label: '对话', icon: <MessageOutlined />, element: <ChatPage /> },
  {
    key: 'approvals',
    path: '/approvals',
    label: '审批',
    icon: <SafetyCertificateOutlined />,
    element: <ApprovalsPage />,
  },
  { key: 'inspection', path: '/inspection', label: '巡检', icon: <ExperimentOutlined />, element: <InspectionPage /> },
  { key: 'alerts', path: '/alerts', label: '告警', icon: <AlertOutlined />, element: <AlertsPage /> },
  { key: 'skills', path: '/skills', label: '技能', icon: <ThunderboltOutlined />, element: <SkillsPage /> },
  { key: 'mcp', path: '/mcp', label: 'MCP', icon: <ApiOutlined />, element: <McpPage /> },
  { key: 'models', path: '/models', label: '模型', icon: <CloudServerOutlined />, element: <ModelsPage /> },
  { key: 'permissions', path: '/permissions', label: '权限', icon: <LockOutlined />, element: <PermissionsPage /> },
  { key: 'knowledge', path: '/knowledge', label: '知识库', icon: <BookOutlined />, element: <KnowledgePage /> },
  {
    key: 'memory',
    path: '/memory',
    label: '记忆',
    icon: <DatabaseOutlined />,
    element: <MemoryPage />,
  },
  {
    key: 'workflows',
    path: '/workflows',
    label: '工作流',
    icon: <PartitionOutlined />,
    element: <WorkflowsPage />,
  },
  {
    key: 'agents',
    path: '/agents',
    label: '智能体',
    icon: <RobotOutlined />,
    element: <AgentsPage />,
  },
  { key: 'kernels', path: '/kernels', label: '内核', icon: <DeploymentUnitOutlined />, element: <KernelsPage /> },
]
