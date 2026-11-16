<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">数据查询探索与自助分析平台</h1>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <header class="app-head">
        <span class="head-desc">面向数据查询编辑器、可视化探索、自助分析看板、数据导出分发、分析笔记协作与查询历史管理的本地化数据分析应用平台。</span>
        <span class="head-user">当前值班：{{ store.operator }} · {{ store.shiftLabel }}</span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { useSessionStore } from '@/stores/session'

const store = useSessionStore()

const navItems = [{ label: "运营概览", path: "/" }, { label: "查询编辑器", path: "/queryeditor" }, { label: "数据源管理", path: "/datasources" }, { label: "查询历史", path: "/queryhistory" }, { label: "图表构建", path: "/chartbuilder" }, { label: "自助看板", path: "/dashboardboard" }, { label: "数据导出", path: "/exporttask" }, { label: "分析笔记", path: "/analysisnote" }, { label: "参数化查询", path: "/paramquery" }, { label: "定时任务", path: "/schedulerjob" }, { label: "数据字典", path: "/dataschema" }, { label: "查询优化", path: "/queryopt" }, { label: "查询性能聚合", path: "/queryperf" }, { label: "透视分析", path: "/pivotable" }, { label: "数据对比", path: "/datacompare" }, { label: "访问控制", path: "/permission" }, { label: "标签分类", path: "/taggroup" }, { label: "结果评估", path: "/resulteval" }, { label: "分享管理", path: "/sharelink" }]
</script>
