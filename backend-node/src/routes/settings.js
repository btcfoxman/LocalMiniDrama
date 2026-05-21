const settingsService = require('../services/settingsService');
const response = require('../response');
const { loadConfig } = require('../config');
const { resolveVideoGenerationTimeoutMinutes } = require('../config/videoGeneration');

function getLanguage(cfg) {
  return (req, res) => {
    const language = settingsService.getLanguage(cfg);
    response.success(res, { language });
  };
}

function updateLanguage(cfg, log) {
  return (req, res) => {
    const lang = req.body?.language;
    if (lang !== 'zh' && lang !== 'en') {
      return response.badRequest(res, '语言参数错误，只支持 zh 或 en');
    }
    const out = settingsService.updateLanguage(cfg, log, lang);
    if (!out.ok) return response.badRequest(res, out.error);
    const message = lang === 'en' ? 'Language switched to English' : '语言已切换为中文';
    response.success(res, { message, language: lang });
  };
}

/** GET /settings/generation — 获取生成相关全局设置 */
function getGenerationSettings(db) {
  return (req, res) => {
    const concurrency = settingsService.getGlobalSetting(db, 'pipeline_concurrency', 3);
    const video_concurrency = settingsService.getGlobalSetting(db, 'pipeline_video_concurrency', 3);
    const video_generation_timeout_minutes = resolveVideoGenerationTimeoutMinutes(loadConfig());
    response.success(res, { concurrency, video_concurrency, video_generation_timeout_minutes });
  };
}

/** PUT /settings/generation — 更新生成相关全局设置 */
function updateGenerationSettings(db) {
  return (req, res) => {
    const { concurrency, video_concurrency } = req.body || {};
    if (concurrency !== undefined) {
      const n = Number(concurrency);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        return response.badRequest(res, '图片并发数需为 1-20 之间的整数');
      }
      settingsService.setGlobalSetting(db, 'pipeline_concurrency', n);
    }
    if (video_concurrency !== undefined) {
      const n = Number(video_concurrency);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        return response.badRequest(res, '视频并发数需为 1-20 之间的整数');
      }
      settingsService.setGlobalSetting(db, 'pipeline_video_concurrency', n);
    }
    const saved = settingsService.getGlobalSetting(db, 'pipeline_concurrency', 3);
    const saved_video = settingsService.getGlobalSetting(db, 'pipeline_video_concurrency', 3);
    const video_generation_timeout_minutes = resolveVideoGenerationTimeoutMinutes(loadConfig());
    response.success(res, {
      concurrency: saved,
      video_concurrency: saved_video,
      video_generation_timeout_minutes,
    });
  };
}

/** GET /settings/storage — 获取存储配置 */
function getStorageSettings(cfg) {
  return (req, res) => {
    response.success(res, settingsService.getStorageSettings(cfg));
  };
}

/** PUT /settings/storage — 更新存储配置 */
function updateStorageSettings(cfg, log) {
  return (req, res) => {
    const out = settingsService.updateStorageSettings(cfg, log, req.body || {});
    if (!out.ok) return response.badRequest(res, out.error);
    response.success(res, out);
  };
}

/** POST /settings/storage/test — 测试远程存储签名上传与删除 */
function testStorageSettings(cfg, log) {
  return async (req, res) => {
    const out = await settingsService.testStorageSettings(cfg, log, req.body?.storage || req.body || null);
    if (!out.ok) return response.badRequest(res, out.error);
    response.success(res, out);
  };
}

module.exports = function settingsRoutes(db, cfg, log) {
  return {
    getLanguage: getLanguage(cfg),
    updateLanguage: updateLanguage(cfg, log),
    getGenerationSettings: getGenerationSettings(db),
    updateGenerationSettings: updateGenerationSettings(db),
    getStorageSettings: getStorageSettings(cfg),
    updateStorageSettings: updateStorageSettings(cfg, log),
    testStorageSettings: testStorageSettings(cfg, log),
  };
};
