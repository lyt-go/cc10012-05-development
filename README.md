# 数据查询探索与自助分析平台

面向数据查询编辑器、可视化探索、自助分析看板、数据导出分发、分析笔记协作与查询历史管理的本地化数据分析应用平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/api/perf-service.ts    查询性能聚合服务：样本构建、版本发布、下钻与导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/data/perf-core.ts      聚合纯计算：耗时归一、错误归类、按脚本聚合
│   ├── src/data/perf-store.ts     聚合样本版本存储：只追加版本、保留当前生效基线
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 查询编辑器 | `queryeditor` | 查询脚本 | 脚本编号、脚本名称、查询语句 |
| 数据源管理 | `datasources` | 数据源连接 | 连接编号、连接名称、连接类型 |
| 查询历史 | `queryhistory` | 历史记录 | 记录编号、脚本记录编号、查询语句摘要、执行时间、返回行数、执行耗时毫秒、错误信息 |
| 图表构建 | `chartbuilder` | 图表配置 | 配置编号、图表名称、图表类型 |
| 自助看板 | `dashboardboard` | 看板布局 | 布局编号、看板名称、包含图表组 |
| 数据导出 | `exporttask` | 导出任务 | 任务编号、数据来源、导出格式 |
| 分析笔记 | `analysisnote` | 笔记条目 | 笔记编号、笔记标题、关联数据集 |
| 参数化查询 | `paramquery` | 参数模板 | 模板编号、模板名称、查询骨架 |
| 定时任务 | `schedulerjob` | 定时作业 | 作业编号、关联查询、调度cron |
| 数据字典 | `dataschema` | 表结构 | 结构编号、表名、字段名 |
| 查询优化 | `queryopt` | 优化建议 | 建议编号、原始查询、优化后查询、关联聚合版本、来源执行记录编号 |
| 查询性能聚合 | `queryperf` | 聚合样本 | 脚本记录编号、样本查询数、平均耗时毫秒、返回行数合计、失败次数、覆盖窗口 |
| 透视分析 | `pivotable` | 透视配置 | 配置编号、数据来源、行维度字段 |
| 数据对比 | `datacompare` | 对比方案 | 方案编号、数据集A、数据集B |
| 访问控制 | `permission` | 访问规则 | 规则编号、数据源、授权人 |
| 标签分类 | `taggroup` | 标签定义 | 标签编号、标签名称、标签颜色 |
| 结果评估 | `resulteval` | 评估记录 | 记录编号、关联查询、结果准确性 |
| 分享管理 | `sharelink` | 分享链接 | 链接编号、分享内容、链接URL |

## 查询性能聚合样本

`queryperf` 页面把查询历史里的原始执行行聚合成按脚本查看的性能样本数据集：

1. **原始执行行**：`queryhistory` 每条记录带脚本记录编号、执行时间、返回行数、`执行耗时毫秒`
   （混写的 `1.4s`、`1,850ms` 会统一换算成毫秒）和错误信息。
2. **错误归类 / 耗时聚合**：一次执行的多行错误摘要只保留一条可解释的主摘要，失败次数按执行行计
   1 次；平均耗时 = Σ耗时 / 样本查询数，返回行数、失败次数按脚本累计。
3. **带覆盖范围的聚合样本版本**：每次生成都记为 `PERF-日期-序号`，只追加不覆盖，并标明覆盖窗口、
   执行批次、来源执行记录数、沿用版本。增量计算只重算窗口内出现的脚本，其他脚本沿用上一份基线；
   已发布的高耗时标记不会因下一次增量计算消失。聚合中断时保留上一份有效版本，只记录一次中断运行。
4. **回溯链路**：脚本行保存来源执行记录编号，页面可从脚本名称下钻到具体执行行、从失败次数定位
   错误摘要，并单独导出执行行明细。

`queryopt` 与聚合样本同源：按同一份数据集展示待优化脚本、同步高耗时标记，并生成独立的
`查询优化待优化清单` 导出文件。清空 `data-explore-selfservice:perf-datasets` 这一项可回到
重新生成基线；查询历史数据本身在 `data-explore-selfservice:entries` 里。

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `data-explore-selfservice:entries` 这一项，或调用 `resetModule(模块)`。

领域：数据工程
子方向：数据分析与数据应用
