'use strict';

var util = require('../util');

/**
 * BaseModelObject is a base type for {@link pubfood/provider} types.
 *
 * @class
 * @memberof pubfood/model
 */
function BaseModelObject() {
  this.id = util.newId();
}

module.exports = BaseModelObject;