/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ensureIsArray, usePrevious } from '@superset-ui/core';
import type { Metric } from '@superset-ui/core';
import { t } from '@apache-superset/core/translation';
import { isEqual } from 'lodash-es';
import ControlHeader from 'src/explore/components/ControlHeader';
import { Icons } from '@superset-ui/core/components/Icons';
import {
  AddIconButton,
  AddControlLabel,
  HeaderContainer,
  LabelsContainer,
} from 'src/explore/components/controls/OptionControls';
import type { Datasource } from 'src/explore/types';
import type { ISaveableDatasource } from 'src/SqlLab/components/SaveDatasetModal';
import MetricDefinitionValue from './MetricDefinitionValue';
import AdhocMetric, { dedupeAdhocMetricOptionName } from './AdhocMetric';
import AdhocMetricPopoverTrigger from './AdhocMetricPopoverTrigger';
import { savedMetricType } from './types';

type MetricColumn = { column_name: string; type: string };
type MetricDefinitionOption = AdhocMetric | savedMetricType | string;
type MetricOption = MetricDefinitionOption | Metric;
type AdhocMetricDefinition = ConstructorParameters<typeof AdhocMetric>[0] & {
  expressionType: string;
};
type MetricInput = MetricOption | AdhocMetricDefinition;

function getOptionsForSavedMetrics(
  savedMetrics: savedMetricType[],
  currentMetricValues: MetricInput | MetricInput[] | null | undefined,
  currentMetric: MetricOption | null,
): savedMetricType[] {
  return (
    savedMetrics?.filter((savedMetric: { metric_name: string }) =>
      Array.isArray(currentMetricValues)
        ? !currentMetricValues.includes(savedMetric.metric_name) ||
          savedMetric.metric_name === currentMetric
        : savedMetric,
    ) ?? []
  );
}

function isDictionaryForAdhocMetric(
  value: unknown,
): value is AdhocMetricDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof AdhocMetric) &&
    'expressionType' in value &&
    Boolean(value.expressionType)
  );
}

// adhoc metrics are stored as dictionaries in URL params. We convert them back into the
// AdhocMetric class for typechecking, consistency and instance method access.
function coerceAdhocMetrics(
  value: MetricInput | MetricInput[] | null | undefined,
): MetricOption[] {
  if (!value) {
    return [];
  }
  if (!Array.isArray(value)) {
    if (isDictionaryForAdhocMetric(value)) {
      return [new AdhocMetric(value)];
    }
    return [value];
  }
  // Metrics are identified by optionName when editing; regenerate any that
  // collide so each keeps a unique identity (see dedupeAdhocMetricOptionName).
  const seenOptionNames = new Set<string>();
  return value.map(val => {
    if (isDictionaryForAdhocMetric(val)) {
      return dedupeAdhocMetricOptionName(new AdhocMetric(val), seenOptionNames);
    }
    return val;
  });
}

const emptySavedMetric = { metric_name: '', expression: '' };

// TODO: use typeguards to distinguish saved metrics from adhoc metrics
const getMetricsMatchingCurrentDataset = (
  value: MetricInput | MetricInput[] | null | undefined,
  columns: MetricColumn[],
  savedMetrics: savedMetricType[],
): MetricInput[] =>
  ensureIsArray<MetricInput>(value).filter(metric => {
    const metricName =
      typeof metric === 'object' && metric !== null && 'metric_name' in metric
        ? metric.metric_name
        : undefined;
    if (typeof metric === 'string' || metricName) {
      return savedMetrics?.some(
        savedMetric =>
          savedMetric.metric_name === metric ||
          savedMetric.metric_name === metricName,
      );
    }
    const metricColumn =
      typeof metric === 'object' && metric !== null && 'column' in metric
        ? metric.column
        : undefined;
    return columns?.some(
      column =>
        !metricColumn || metricColumn.column_name === column.column_name,
    );
  });

export interface MetricsControlProps {
  name: string;
  onChange: (value: unknown) => void;
  multi?: boolean;
  value?: MetricInput | MetricInput[];
  columns?: MetricColumn[];
  savedMetrics?: savedMetricType[];
  datasource?: Datasource & ISaveableDatasource;
  clearable?: boolean;
  isLoading?: boolean;
  [key: string]: unknown;
}

const MetricsControl = ({
  onChange = () => {},
  multi,
  value: propsValue,
  columns = [],
  savedMetrics = [],
  datasource,
  ...props
}: MetricsControlProps) => {
  const [value, setValue] = useState(coerceAdhocMetrics(propsValue));
  const prevColumns = usePrevious(columns);
  const prevSavedMetrics = usePrevious(savedMetrics);

  const handleChange = useCallback(
    (opts: MetricInput | MetricInput[] | null) => {
      // if clear out options
      if (opts === null) {
        onChange(null);
        return;
      }

      const transformedOpts = ensureIsArray(opts);
      const optionValues = transformedOpts
        .map(option => {
          // pre-defined metric
          const metricName =
            typeof option === 'object' &&
            option !== null &&
            'metric_name' in option
              ? option.metric_name
              : undefined;
          if (metricName) {
            return metricName;
          }
          return option;
        })
        .filter((option: unknown) => option);
      onChange(multi ? optionValues : optionValues[0]);
    },
    [multi, onChange],
  );

  const onNewMetric = useCallback(
    (newMetric: Metric) => {
      const newValue = [...value, newMetric];
      setValue(newValue);
      handleChange(newValue);
    },
    [handleChange, value],
  );

  const onMetricEdit = useCallback(
    (changedMetric: Metric, oldMetric: Metric) => {
      const newValue = value.map(val => {
        const optionName =
          typeof val === 'object' && val !== null && 'optionName' in val
            ? val.optionName
            : undefined;
        const oldMetricOptionName =
          typeof oldMetric === 'object' &&
          oldMetric !== null &&
          'optionName' in oldMetric
            ? oldMetric.optionName
            : undefined;
        if (
          // compare saved metrics
          val === oldMetric.metric_name ||
          // compare adhoc metrics
          typeof optionName !== 'undefined'
            ? optionName === oldMetricOptionName
            : false
        ) {
          return changedMetric;
        }
        return val;
      });
      setValue(newValue);
      handleChange(newValue);
    },
    [handleChange, value],
  );

  const onRemoveMetric = useCallback(
    (index: number) => {
      if (!Array.isArray(value)) {
        return;
      }
      const valuesCopy = [...value];
      valuesCopy.splice(index, 1);
      setValue(valuesCopy);
      handleChange(valuesCopy);
    },
    [handleChange, value],
  );

  const moveLabel = useCallback(
    (dragIndex: number, hoverIndex: number) => {
      const newValues = [...value];
      [newValues[hoverIndex], newValues[dragIndex]] = [
        newValues[dragIndex],
        newValues[hoverIndex],
      ];
      setValue(newValues);
    },
    [value],
  );

  const isAddNewMetricDisabled = useCallback(
    () => !multi && value.length > 0,
    [multi, value.length],
  );

  const savedMetricOptions = useMemo(
    () => getOptionsForSavedMetrics(savedMetrics, propsValue, null),
    [propsValue, savedMetrics],
  );

  const newAdhocMetric = useMemo(() => new AdhocMetric({}), [value]);
  const addNewMetricPopoverTrigger = useCallback(
    (trigger: React.ReactNode) => {
      if (isAddNewMetricDisabled()) {
        return trigger;
      }
      return (
        <AdhocMetricPopoverTrigger
          adhocMetric={newAdhocMetric}
          onMetricEdit={onNewMetric}
          columns={columns}
          savedMetricsOptions={savedMetricOptions}
          savedMetric={emptySavedMetric}
          datasource={datasource!}
          isNew
        >
          {trigger}
        </AdhocMetricPopoverTrigger>
      );
    },
    [
      columns,
      datasource,
      isAddNewMetricDisabled,
      newAdhocMetric,
      onNewMetric,
      savedMetricOptions,
    ],
  );

  useEffect(() => {
    // Remove selected custom metrics that do not exist in the dataset anymore
    // Remove selected adhoc metrics that use columns which do not exist in the dataset anymore
    if (
      propsValue &&
      (!isEqual(prevColumns, columns) ||
        !isEqual(prevSavedMetrics, savedMetrics))
    ) {
      const matchingMetrics = getMetricsMatchingCurrentDataset(
        propsValue,
        columns,
        savedMetrics,
      );
      if (!isEqual(matchingMetrics, propsValue)) {
        handleChange(matchingMetrics);
      }
    }
  }, [columns, handleChange, savedMetrics]);

  useEffect(() => {
    setValue(coerceAdhocMetrics(propsValue));
  }, [propsValue]);

  const onDropLabel = useCallback(
    () => handleChange(value),
    [handleChange, value],
  );

  const valueRenderer = useCallback(
    (option: MetricOption, index: number) => (
      <MetricDefinitionValue
        key={index}
        index={index}
        option={option}
        onMetricEdit={onMetricEdit}
        onRemoveMetric={onRemoveMetric}
        columns={columns}
        datasource={datasource}
        savedMetrics={savedMetrics}
        savedMetricsOptions={getOptionsForSavedMetrics(
          savedMetrics,
          value,
          value?.[index],
        )}
        onMoveLabel={moveLabel}
        onDropLabel={onDropLabel}
        multi={multi}
      />
    ),
    [
      columns,
      datasource,
      moveLabel,
      multi,
      onDropLabel,
      onMetricEdit,
      onRemoveMetric,
      savedMetrics,
      value,
    ],
  );

  return (
    <div className="metrics-select">
      <HeaderContainer>
        <ControlHeader {...props} />
        {addNewMetricPopoverTrigger(
          <AddIconButton
            disabled={isAddNewMetricDisabled()}
            data-test="add-metric-button"
          >
            <Icons.PlusOutlined iconSize="m" />
          </AddIconButton>,
        )}
      </HeaderContainer>
      <LabelsContainer>
        {value.length > 0
          ? value.map((value, index) => valueRenderer(value, index))
          : addNewMetricPopoverTrigger(
              <AddControlLabel>
                <Icons.PlusOutlined iconSize="m" />
                {t('Add metric')}
              </AddControlLabel>,
            )}
      </LabelsContainer>
    </div>
  );
};

// Was a PureComponent before the FC conversion; preserve shallow-equal skip.
export default memo(MetricsControl);
