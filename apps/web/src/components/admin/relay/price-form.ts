/**
 * 价格录入表单的值（界面按「积分 / 百万 token」填，提交时用 `pointsToMicro` 换算）。
 *
 * 单独放一个 `.ts` 文件是因为 `<script setup>` 里不能 `export` 类型，而渠道抽屉与模型弹窗都要用它。
 */
export interface PriceForm {
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  perRequest: string
}
