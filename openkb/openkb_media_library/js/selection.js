/**
 * @file
 * Hands the media-library selection to the editor on the same page.
 *
 * The dialog runs in the editor's own document (opened via Drupal.ajax
 * against media_library.ui). The selection form's AJAX response carries an
 * `okbMediaSelected` command (MediaSelectionCommand) with the selected
 * media UUIDs; this handler dispatches them as a CustomEvent on `document`
 * for the editor to pick up. Same-document — no messaging layer, no
 * origin concerns.
 */
(function (Drupal) {

  'use strict';

  Drupal.AjaxCommands.prototype.okbMediaSelected = function (ajax, response) {
    document.dispatchEvent(new CustomEvent('okb:media-selected', {
      detail: { uuids: response.uuids || [] },
    }));
  };

})(Drupal);
