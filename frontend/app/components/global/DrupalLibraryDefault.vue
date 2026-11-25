<script lang="ts">
import type { PropType } from 'vue'

/**
 * Loads a Drupal JavaScript library a form attaches, e.g. the AJAX upload of
 * a file field.
 *
 * Drupal sends one `drupal-library-*` element per library, in dependency
 * order. nuxtjs-drupal-ce's `loadLibrary()` loads the scripts once, seeds
 * `drupalSettings` and attaches Drupal's behaviors. Renderless.
 */
export default defineComponent({
  props: {
    /** The library name, e.g. `core/drupal.ajax`. */
    library: {
      type: String,
      required: true,
    },
    /** The library's JS files, in load order. */
    js: {
      type: Array as PropType<{ url: string }[]>,
      default: () => [],
    },
    /** The page's drupalSettings, as JSON: on the first element only. */
    drupalSettings: {
      type: String,
      default: undefined,
    },
  },
  /**
   * Loads the library on mount; renders nothing.
   */
  setup(props) {
    const { loadLibrary } = useDrupalCe()
    onMounted(() => {
      loadLibrary({ name: props.library, js: props.js, drupalSettings: props.drupalSettings })
    })
    return () => null
  },
})
</script>
