/*globals define*/
/*
 * Финальная версия генератора YAML для Home Assistant.
 * Корректно обрабатывает внешние и внутренние переходы, а также узлы "Выбор" (Choice).
 */
define([
    'bower/js-yaml/dist/js-yaml.min', 
], function (
    jsyaml
) {
    'use strict';

    // --- Вспомогательные функции ---
    const toSnakeCase = (str) => {
        if (!str) return '';
        return str.replace(/[\s\W]+/g, '_')
                  .replace(/([A-Z])/g, '_$1')
                  .replace(/__+/g, '_')
                  .replace(/^_|_$/g, '')
                  .toLowerCase();
    };
    
    const safeLoadYamlAction = (yamlString, logger) => {
        if (!yamlString || typeof yamlString !== 'string' || yamlString.trim() === '') return [];
        try {
            const parsed = jsyaml.load(yamlString);
            if (Array.isArray(parsed)) return parsed;
            if (typeof parsed === 'object' && parsed !== null) return [parsed];
            (logger || console).warn(`Содержимое YAML было разобрано, но не является объектом/массивом: ${yamlString}`);
            return [];
        } catch (e) {
            (logger || console).warn(`Не удалось разобрать строку YAML. Ошибка: ${e.message}. Содержимое: "${yamlString}"`);
            return [];
        }
    };

    /**
     * Рекурсивно строит последовательность действий, прослеживая путь через узлы выбора.
     * @param {object} transition - Текущий переход для обработки.
     * @param {object} objects - Словарь всех объектов модели.
     * @param {string} smSnakeName - Имя машины состояний в snake_case.
     * @param {object} logger - Логгер.
     * @returns {Array} - Массив действий для Home Assistant.
     */
    function buildActionSequence(transition, objects, smSnakeName, logger) {
        let sequence = [];
        const targetNode = objects[transition.pointers.dst];

        // 1. Добавляем действие самого перехода
        sequence.push(...safeLoadYamlAction(transition.attributes.Action, logger));

        // 2. Проверяем, куда ведет переход
        if (targetNode.type === 'State' || targetNode.type === 'End State') {
            // Конечная точка: меняем состояние и выполняем entry-действие
            sequence.push({
                service: 'input_select.select_option',
                target: { entity_id: `input_select.${smSnakeName}` },
                data: { option: toSnakeCase(targetNode.sanitizedName) }
            });
            sequence.push(...safeLoadYamlAction(targetNode.attributes.Entry, logger));
        } else if (targetNode.type === 'Choice Pseudostate') {
            // Промежуточная точка: создаем вложенный блок choose
            const outgoingFromChoice = Object.values(objects)
                .filter(o => o.type === 'External Transition' && o.pointers.src === targetNode.path);
            
            const defaultBranch = outgoingFromChoice.find(t => !t.attributes.Guard);
            const guardedBranches = outgoingFromChoice.filter(t => t.attributes.Guard);

            const innerChoose = {
                choose: guardedBranches.map(branch => ({
                    conditions: [{
                        condition: 'template',
                        // Убираем скобки [ ] если они есть (на всякий случай)
                        value_template: `{{ ${branch.attributes.Guard.replace(/^\[|\]$/g, '').trim()} }}`
                    }],
                    sequence: buildActionSequence(branch, objects, smSnakeName, logger)
                }))
            };
            
            if (defaultBranch) {
                innerChoose.default = buildActionSequence(defaultBranch, objects, smSnakeName, logger);
            }

            sequence.push(innerChoose);
        }
        return sequence;
    }

    return {
        renderHFSM: function (model, namespace, objToFilePrefixFn) {
            const logger = this.logger || console;
            const objects = model.objects;
            let generatedArtifacts = {};

            const smRoot = Object.values(objects).find(o => o.type === 'State Machine');
            if (!smRoot) {
                logger.warn('Не найдена "State Machine" в модели.');
                return {};
            }

            const smSnakeName = toSnakeCase(smRoot.sanitizedName);
            const inputSelectEntityId = `input_select.${smSnakeName}`;
            const eventType = `${smSnakeName}_event`;

            const states = Object.values(objects).filter(o => o.type === 'State' || o.type === 'End State');
            const transitions = Object.values(objects).filter(o => o.type === 'External Transition' || o.type === 'Internal Transition');
            
            let initialStateName = null;
            const initialTransition = transitions.find(t => objects[t.pointers.src] && objects[t.pointers.src].type === 'Initial');
            if (initialTransition && objects[initialTransition.pointers.dst]) {
                initialStateName = toSnakeCase(objects[initialTransition.pointers.dst].sanitizedName);
            }

            // --- Генерация YAML ---
            let haConfig = {};

            // 1. input_select
            haConfig.input_select = {};
            haConfig.input_select[smSnakeName] = {
                name: smRoot.sanitizedName,
                options: states.map(s => toSnakeCase(s.sanitizedName)),
                initial: initialStateName,
                icon: 'mdi:state-machine',
            };

            // 2. automation
            const mainChoose = [];

            for (const state of states) {
                // Находим все переходы, исходящие из этого состояния
                const outgoingTransitions = transitions.filter(t => t.pointers.src === state.path);
                
                for (const trans of outgoingTransitions) {
                    const eventName = trans.attributes.Event;
                    if (!eventName) continue; // Пропускаем переходы без события (например, из узла Выбор)

                    const sourceState = state;
                    let sequence = [];

                    if (trans.type === 'External Transition') {
                        // Внешний переход: Exit -> Transition Action -> ...
                        sequence.push(...safeLoadYamlAction(sourceState.attributes.Exit, logger));
                        sequence.push(...buildActionSequence(trans, objects, smSnakeName, logger));
                    } else { // Internal Transition
                        // Внутренний переход: только действие самого перехода
                        sequence.push(...safeLoadYamlAction(trans.attributes.Action, logger));
                    }

                    mainChoose.push({
                        conditions: [
                            { condition: 'state', entity_id: inputSelectEntityId, state: toSnakeCase(sourceState.sanitizedName) },
                            { condition: 'template', value_template: `{{ trigger.event.data.event == '${eventName}' }}` }
                        ],
                        sequence: sequence
                    });
                }
            }

            haConfig.automation = [{
                id: `${smSnakeName}_automation`,
                alias: `State Machine: ${smRoot.sanitizedName}`,
                description: `Handles state transitions for ${smRoot.sanitizedName}`,
                mode: 'single',
                trigger: [{ platform: 'event', event_type: eventType }],
                action: [{ choose: mainChoose }]
            }];
            
            // --- Создание артефакта ---
            const yamlString = jsyaml.dump(haConfig, { indent: 2, lineWidth: -1, noRefs: true });
            const fileHeader = `#\n# Auto-generated Home Assistant configuration for "${smRoot.sanitizedName}" state machine.\n` +
                             `# Generated by WebGME plugin on ${new Date().toISOString()}\n#\n\n`;
            const fileName = `${smSnakeName}.yaml`;
            generatedArtifacts[fileName] = fileHeader + yamlString;
            
            return generatedArtifacts;
        },

        renderTestCode: function (model, namespace, objToFilePrefixFn) {
            return {};
        }
    };
});