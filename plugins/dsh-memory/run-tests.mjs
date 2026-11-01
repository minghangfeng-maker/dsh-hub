/**
 * `node --test test/` 的入口。
 *
 * Node 24 的 `--test` 参数只接受文件或 glob，传目录会按普通模块解析；目录里的
 * package.json `main` 指到这里（见 test/package.json）。这里把全部测试文件
 * import 一遍，顶层 test() 就会注册到当前 test runner。
 *
 * `node --test`（不带参数）会直接发现 test/*.test.js，两种跑法等价且不会重复。
 */

import './test/paths.test.js'
import './test/store.test.js'
import './test/indexer.test.js'
import './test/inject.test.js'
import './test/notes.test.js'
import './test/tools.test.js'
import './test/consolidate.test.js'
import './test/api.test.js'
import './test/scheduler.test.js'
import './test/security.test.js'
import './test/graph.test.js'
