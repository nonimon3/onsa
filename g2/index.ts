import type { AppModule } from '../_shared/app-types'
import { createOnsaActions } from './main'

export const app: AppModule = {
  id: 'onsa',
  name: 'Onsa',
  pageTitle: 'Onsa — G2 Chromatic Tuner',
  connectLabel: 'Connect Glasses',
  actionLabel: 'Toggle Mic',
  initialStatus: 'Onsa ready — Connect を押してからマイクを許可してください',
  createActions: createOnsaActions,
}

export default app
