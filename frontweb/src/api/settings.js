import request from '@/utils/request'

export const storageSettingsAPI = {
  get() {
    return request.get('/settings/storage')
  },
  update(data) {
    return request.put('/settings/storage', data)
  },
  test(storage) {
    return request.post('/settings/storage/test', { storage })
  },
}
