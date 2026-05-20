<template>
  <div class="storage-config-panel" v-loading="loading">
    <div class="storage-head">
      <div>
        <h3>存储设置</h3>
        <p>本地模式不会上传到云端 S3。模型生成需要参考图时，后端会读取本地文件并转成 base64 随请求提交。</p>
      </div>
      <div class="storage-state">
        <el-tag :type="isS3Mode ? 'warning' : 'success'" effect="plain">
          {{ isS3Mode ? 'S3 模式' : '本地模式' }}
        </el-tag>
        <span v-if="form.user_customized" class="state-pill">用户配置</span>
      </div>
    </div>

    <el-alert
      :type="isS3Mode ? 'warning' : 'info'"
      :closable="false"
      show-icon
      class="storage-alert"
      :title="isS3Mode
        ? 'S3 模式会把上传图片、编辑后图片和生成结果同步到你填写的对象存储。'
        : '打包版默认使用本地存储，S3 配置为空；后续升级不会覆盖你保存过的自定义配置。'"
    />

    <el-form label-position="top" class="storage-form">
      <div class="mode-row">
        <el-radio-group v-model="form.type" size="large">
          <el-radio-button label="local">
            <el-icon><FolderOpened /></el-icon>
            本地
          </el-radio-button>
          <el-radio-button label="s3">
            <el-icon><Cloudy /></el-icon>
            S3
          </el-radio-button>
        </el-radio-group>
      </div>

      <div class="form-grid local-grid">
        <el-form-item label="本地存储目录" class="span-2">
          <el-input v-model="form.local_path" placeholder="./data/storage-cache" />
        </el-form-item>
      </div>

      <template v-if="isS3Mode">
        <div class="form-grid">
          <el-form-item label="Endpoint">
            <el-input v-model="form.endpoint" placeholder="https://your-s3.example.com" />
          </el-form-item>
          <el-form-item label="Bucket">
            <el-input v-model="form.bucket" placeholder="bucket-name" />
          </el-form-item>
          <el-form-item label="Region">
            <el-input v-model="form.region" placeholder="us-east-1" />
          </el-form-item>
          <el-form-item label="Access Key ID">
            <el-input v-model="form.access_key_id" autocomplete="off" />
          </el-form-item>
          <el-form-item label="Secret Access Key">
            <el-input v-model="form.secret_access_key" type="password" show-password autocomplete="new-password" />
          </el-form-item>
          <el-form-item label="签名 Host">
            <el-input v-model="form.signing_host" placeholder="可留空；Cloudflared/RustFS 场景可填内网 Host" />
          </el-form-item>
          <el-form-item label="公开访问 Base URL" class="span-2">
            <el-input v-model="form.public_base_url" placeholder="https://cdn.example.com/bucket" />
          </el-form-item>
          <el-form-item label="兼容 Base URL" class="span-2">
            <el-input v-model="form.base_url" placeholder="未填时优先使用公开访问 Base URL" />
          </el-form-item>
        </div>

        <div class="switch-row">
          <el-switch v-model="form.force_path_style" active-text="Path-style 访问" />
          <el-switch v-model="form.public_read" active-text="上传对象公开读" />
        </div>
      </template>

      <div class="preview-line">
        <span>URL 预览</span>
        <code>{{ publicPreview }}</code>
      </div>

      <div class="storage-actions">
        <el-button type="primary" :loading="saving" @click="save">
          <el-icon><Check /></el-icon>
          保存
        </el-button>
        <el-button v-if="isS3Mode" plain :loading="testing" @click="test">
          <el-icon><Connection /></el-icon>
          测试上传
        </el-button>
        <el-button plain @click="resetLocalMode">
          <el-icon><RefreshLeft /></el-icon>
          恢复本地模式
        </el-button>
      </div>
    </el-form>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, Cloudy, Connection, FolderOpened, RefreshLeft } from '@element-plus/icons-vue'
import { storageSettingsAPI } from '@/api/settings'

const LOCAL_DEFAULT = Object.freeze({
  type: 'local',
  local_path: './data/storage-cache',
  base_url: '',
  public_base_url: '',
  endpoint: '',
  bucket: '',
  region: 'us-east-1',
  force_path_style: true,
  signing_host: '',
  public_read: false,
  access_key_id: '',
  secret_access_key: '',
  user_customized: false,
})

const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const form = reactive({ ...LOCAL_DEFAULT })

const isS3Mode = computed(() => form.type === 's3')
const publicPreview = computed(() => {
  if (!isS3Mode.value) return '/static/example.png'
  const base = (form.public_base_url || form.base_url || '').replace(/\/$/, '')
  if (base) return `${base}/example.png`
  const endpoint = (form.endpoint || '').replace(/\/$/, '')
  return endpoint && form.bucket ? `${endpoint}/${form.bucket}/example.png` : 'example.png'
})

function applyStorage(storage = {}) {
  const type = String(storage.type || 'local').toLowerCase() === 's3' ? 's3' : 'local'
  Object.assign(form, {
    ...LOCAL_DEFAULT,
    ...storage,
    type,
    local_path: storage.local_path || LOCAL_DEFAULT.local_path,
    region: storage.region || LOCAL_DEFAULT.region,
    force_path_style: storage.force_path_style !== false,
    public_read: type === 's3' ? storage.public_read !== false : false,
    user_customized: !!storage.user_customized,
  })
}

function normalizePayload() {
  if (!isS3Mode.value) {
    return {
      ...LOCAL_DEFAULT,
      type: 'local',
      local_path: String(form.local_path || LOCAL_DEFAULT.local_path).trim() || LOCAL_DEFAULT.local_path,
    }
  }
  return {
    type: 's3',
    local_path: String(form.local_path || LOCAL_DEFAULT.local_path).trim() || LOCAL_DEFAULT.local_path,
    base_url: String(form.base_url || '').trim(),
    public_base_url: String(form.public_base_url || '').trim(),
    endpoint: String(form.endpoint || '').trim(),
    bucket: String(form.bucket || '').trim(),
    region: String(form.region || '').trim() || LOCAL_DEFAULT.region,
    force_path_style: !!form.force_path_style,
    signing_host: String(form.signing_host || '').trim(),
    public_read: !!form.public_read,
    access_key_id: String(form.access_key_id || '').trim(),
    secret_access_key: String(form.secret_access_key || '').trim(),
  }
}

function validatePayload(payload) {
  if (payload.type !== 's3') return ''
  if (!payload.endpoint) return '请填写 S3 Endpoint'
  if (!/^https?:\/\//i.test(payload.endpoint)) return 'Endpoint 必须以 http:// 或 https:// 开头'
  if (!payload.bucket) return '请填写 Bucket'
  if (!payload.access_key_id) return '请填写 Access Key ID'
  if (!payload.secret_access_key) return '请填写 Secret Access Key'
  return ''
}

async function loadStorageSettings() {
  loading.value = true
  try {
    const res = await storageSettingsAPI.get()
    applyStorage(res?.storage || {})
  } finally {
    loading.value = false
  }
}

async function save() {
  const payload = normalizePayload()
  const error = validatePayload(payload)
  if (error) {
    ElMessage.warning(error)
    return
  }
  saving.value = true
  try {
    const res = await storageSettingsAPI.update(payload)
    applyStorage(res?.storage || payload)
    ElMessage.success(payload.type === 's3' ? 'S3 配置已保存' : '本地存储已启用')
  } finally {
    saving.value = false
  }
}

async function test() {
  const payload = normalizePayload()
  const error = validatePayload(payload)
  if (error) {
    ElMessage.warning(error)
    return
  }
  testing.value = true
  try {
    const res = await storageSettingsAPI.test(payload)
    ElMessage.success(res?.deleted ? 'S3 签名上传测试通过' : '上传通过，测试文件清理失败')
  } finally {
    testing.value = false
  }
}

function resetLocalMode() {
  applyStorage({ ...LOCAL_DEFAULT, local_path: form.local_path || LOCAL_DEFAULT.local_path })
  ElMessage.info('已切换为本地模式，保存后生效')
}

onMounted(loadStorageSettings)
</script>

<style scoped>
.storage-config-panel {
  max-width: 860px;
}
.storage-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 12px;
}
.storage-head h3 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 700;
  color: var(--el-text-color-primary);
}
.storage-head p {
  margin: 0;
  color: var(--el-text-color-regular);
  font-size: 13px;
  line-height: 1.6;
}
.storage-state {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.state-pill {
  border: 1px solid rgba(64, 158, 255, 0.26);
  background: rgba(64, 158, 255, 0.08);
  color: #2b7ecb;
  border-radius: 999px;
  font-size: 12px;
  padding: 2px 9px;
}
.storage-alert {
  margin-bottom: 16px;
}
.storage-form {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 18px;
  background: var(--el-fill-color-blank);
}
.mode-row {
  margin-bottom: 16px;
}
.mode-row :deep(.el-radio-button__inner) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 92px;
  justify-content: center;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  column-gap: 14px;
  row-gap: 2px;
}
.local-grid {
  margin-bottom: 2px;
}
.span-2 {
  grid-column: span 2;
}
.switch-row {
  display: flex;
  align-items: center;
  gap: 22px;
  margin: 4px 0 14px;
}
.preview-line {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  font-size: 13px;
}
.preview-line span {
  flex-shrink: 0;
  font-weight: 600;
}
.preview-line code {
  word-break: break-all;
  color: var(--el-text-color-primary);
  background: transparent;
  padding: 0;
}
.storage-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 16px;
}
.storage-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}
@media (max-width: 820px) {
  .storage-head {
    flex-direction: column;
  }
  .form-grid {
    grid-template-columns: 1fr;
  }
  .span-2 {
    grid-column: auto;
  }
  .switch-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
}
</style>
