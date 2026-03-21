<script setup lang="ts">
import { ACCENT_COLOR_IDS, ACCENT_COLOR_TOKENS, type AccentColorId } from '#shared/utils/constants'

// This page exists only as a rendering target for nuxt-og-image.
// Visiting it directly redirects to the package page.

const route = useRoute()
const org = (route.params as any).org as string | undefined
const name = (route.params as any).name as string
const packageName = org ? `${org}/${name}` : name
const theme = route.query.theme === 'light' ? 'light' : 'dark'
const colorParam = route.query.color as string | undefined
const color: AccentColorId = ACCENT_COLOR_IDS.includes(colorParam as AccentColorId)
  ? (colorParam as AccentColorId)
  : 'sky'

const primaryColor = ACCENT_COLOR_TOKENS[color][theme].hex

defineOgImageComponent(
  'ShareCard',
  { name: packageName, theme, primaryColor },
  { width: 1280, height: 520 },
)

onMounted(() => {
  navigateTo(`/package/${packageName}`, { replace: true })
})
</script>

<template>
  <div />
</template>
