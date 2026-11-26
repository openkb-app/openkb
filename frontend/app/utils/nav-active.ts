/**
 * The tint of the nav link to the current page: outline rows, the collapsed
 * rail and the sidebar's Search row.
 *
 * Keyed on `aria-current="page"`, which the router sets on an exact-active
 * NuxtLink. The text is the brand's interactive colour, which clears 4.5:1
 * on its own 12% tint.
 */
export const NAV_ACTIVE_CLASS = 'aria-[current=page]:bg-primary/12 aria-[current=page]:text-primary'
