<template>
  <el-button v-if="available" :loading="checking" :title="version ? '当前版本 v' + version : '检查客户端更新'" @click="check">
    {{ checking ? '正在检查更新' : '检查更新' }}
  </el-button>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

const available = typeof window !== 'undefined' && typeof window.desktopApp?.checkForUpdates === 'function'
const checking = ref(false)
const version = ref('')
onMounted(async () => {
  if (available) version.value = await window.desktopApp.getVersion().catch(() => '')
})
async function check() {
  if (checking.value) return
  checking.value = true
  try { await window.desktopApp.checkForUpdates() }
  catch (error) { ElMessage.error(error.message || '更新检查失败，请重试') }
  finally { checking.value = false }
}
</script>
